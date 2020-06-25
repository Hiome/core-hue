#!/usr/bin/env node

const fs = require('fs')
const huejay = require('huejay')
const mqtt = require('mqtt')
const Sentry = require('@sentry/node')

Sentry.init()

// persist Hue username and current state to disk so we can restore on restart
const DATA_PATH = '/data/hue/hue.json'

const CONNECTED        = 'connected'
const NO_BRIDGES_FOUND = 'no_bridges_found'
const NO_LINK_PUSHED   = 'no_link_pushed'
const FAILURE          = 'fail'

// track day/night status
let isNight = undefined
let onlyControlAtNight = true
// protect data file from being written simultaneously
let isWriting = false
let hue = null
// data to be persisted
let data = {
  hueUsername: null,
  sensorVals: {},
  sensorNames: {},
  sensorNameById: {}
}

// attempt to read previous data cache, if it exists
if (fs.existsSync(DATA_PATH)) {
  const dataFile = fs.readFileSync(DATA_PATH, {encoding: 'utf8'})
  try {
    data = {...data, ...JSON.parse(dataFile)}
  } catch(e) {
    Sentry.captureException(e)
    Sentry.captureMessage(dataFile)
  }
}

// cache data file to disk because we don't want lights to turn on if system reboots in middle of night
function persistDataFile() {
  if (!isWriting) {
    isWriting = true
    fs.writeFile(DATA_PATH, JSON.stringify(data), function(err) {
      if (err) Sentry.captureException(err)
      isWriting = false
    })
  }
}

function saveUsername(name) {
  data.hueUsername = name
  persistDataFile()
}

function sensorValChanged(sensorId, occupied) {
  if (data.sensorVals[sensorId] === occupied) return false

  data.sensorVals[sensorId] = occupied
  persistDataFile()

  return true
}

function updateSensorName(sensorId, sensorName) {
  if (data.sensorNames[sensorName] !== sensorId) {
    data.sensorNames[sensorName] = sensorId
    data.sensorNameById[sensorId] = sensorName
    persistDataFile()
  }
}

function disconnect() {
  saveUsername(null)
  hue = null
  publish(null)
}

// discover bridges via UPnP and N-UPnP
function connect() {
  huejay.discover({strategy: 'all'})
    .then(validateBridges)
    .catch(error => {
      publish(FAILURE)
      Sentry.captureException(error)
    })
}

// determine if bridge is actually accessible to us
function validateBridges(bridges) {
  // make sure device is online
  const promises = bridges.map(bridge => {
    return new huejay.Client({host: bridge.ip}).bridge.ping()
      .then(() => bridge.ip)
      .catch(error => null)
  })

  Promise.all(promises).then(pingables => {
    // remove duplicates and nulls
    const bridgesFrd = [...new Set(pingables)].filter(x => x)
    if (bridgesFrd.length === 0) {
      publish(NO_BRIDGES_FOUND)
    } else {
      Promise.all(bridgesFrd.map(bridge => authenticateUser(bridge))).then(authenticatable => {
        if (authenticatable.filter(x => x === CONNECTED).length === 1)
          publish(CONNECTED)
        else if (authenticatable.some(x => x === FAILURE))
          publish(FAILURE)
        else
          publish(NO_LINK_PUSHED)
      })
    }
  })
}

function authenticateUser(host) {
  if (data.hueUsername) {
    // try authenticating with existing username before moving forward
    hue = new huejay.Client({host, username: data.hueUsername})
    return hue.bridge.isAuthenticated()
      .then(() => CONNECTED)
      .catch(error => {
        hue = null
        return createUser(host)
      })
  } else {
    return createUser(host)
  }
}

function createUser(host) {
  const client = new huejay.Client({host})
  let user = new client.users.User
  user.deviceType = 'Hiome'

  return client.users.create(user)
    .then(user => {
      saveUsername(user.username)
      hue = new huejay.Client({host, username: data.hueUsername})
      return CONNECTED
    })
    .catch(error => {
      if (error instanceof huejay.Error && error.type === 101)
        return NO_LINK_PUSHED
      else {
        Sentry.captureException(error)
        return FAILURE
      }
    })
}

// clean out punctuation and spaces from room names
function sanitizeName(str) {
  return str.replace(/[^\w\s_\-]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
}

const hiome = mqtt.connect('mqtt://localhost:1883')

function publish(status) {
  if (status)
    hiome.publish('hs/1/com.hiome/hue/connected', JSON.stringify({val: status, ts: Date.now()}), {qos: 1, retain: true})
  else
    hiome.publish('hs/1/com.hiome/hue/connected', '', {retain: true})
}

hiome.on('connect', function() {
  hiome.subscribe('hs/1/+/+/to/com.hiome/hue/scan', {qos: 1})
  hiome.subscribe('hs/1/com.hiome/hue/night_only', {qos: 1})
  hiome.subscribe('hs/1/com.hiome/+/name', {qos: 1})
  hiome.subscribe('hs/1/com.hiome/+/occupancy', {qos: 1})
  hiome.subscribe('hs/1/com.hiome/sun/position', {qos: 1})
  hiome.subscribe('_hiome/integrate/hue', {qos: 1})
  hiome.subscribe('_hiome/integrate/hue/settings/#', {qos: 1})
  connect() // connect to hue bridge now that we're ready
})

let debounceTimer = new Date()

hiome.on('message', function(topic, m, packet) {
  if (m.length === 0) return
  const topic_parts = topic.split("/")
  const msg = m.toString()
  const message = JSON.parse(msg)
  if (topic_parts[4] === 'occupancy') {
    const sensorId = topic_parts[3]
    const occupied = message['val'] > 0

    // only do something if the occupancy state of the room is changing
    if (!sensorValChanged(sensorId, occupied) || !hue) return

    const sensorName = data.sensorNameById[sensorId]
    if (!sensorName) return

    hue.groups.getAll()
      .then(groups => {
        for (let group of groups) {
          if (sanitizeName(group.name) === sensorName) {
            if (occupied && (isNight || !onlyControlAtNight))
              group.on = true
            else if (!occupied)
              group.on = false
            return hue.groups.save(group)
          }
        }
      })
      .catch(error => Sentry.captureException(error))
  } else if (topic_parts[4] === 'name') {
    const name = sanitizeName(message.val)
    updateSensorName(topic_parts[3], name)
  } else if (topic_parts[4] === 'position') {
    const wasNight = isNight
    isNight = message['val'] === 'sunset'
    if (wasNight === undefined || isNight === wasNight || !hue || !isNight) return

    hue.groups.getAll()
      .then(groups => {
        for (let group of groups) {
          const santizedGroupName = sanitizeName(group.name)
          if (santizedGroupName in data.sensorNames) {
            group.on = data.sensorVals[data.sensorNames[santizedGroupName]]
            hue.groups.save(group)
          }
        }
      })
      .catch(error => Sentry.captureException(error))
  } else if (topic_parts[4] === 'night_only') {
    onlyControlAtNight = message.val
  } else if (topic_parts[7] === 'scan') {
    if (new Date() - debounceTimer < 15000) return // in case user has multiple tabs open auto-smashing connect
    debounceTimer = new Date()
    message.val ? connect() : disconnect()
  } else if (topic === '_hiome/integrate/hue') { // legacy branch
    if (new Date() - debounceTimer < 15000) return // in case user has multiple tabs open auto-smashing connect
    debounceTimer = new Date()
    if (msg === 'connect') connect()
    else if (msg === 'disconnect') disconnect()
  } else if (topic.startsWith('_hiome/integrate/hue/settings/')) { // legacy branch
    if (topic.endsWith('onlyControlAtNight')) {
      onlyControlAtNight = msg === 'true'
      // republish to new format
      const payload = {val: onlyControlAtNight, ts: Date.now()}
      hiome.publish('hs/1/com.hiome/hue/night_only', JSON.stringify(payload), {qos: 1, retain: true})
      hiome.publish(topic, '', {retain: true, qos: 1}) // clear old format
    }
  }
})
