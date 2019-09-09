#!/usr/bin/env node

const fs = require('fs')
const huejay = require('huejay')
const mqtt = require('mqtt')
const Sentry = require('@sentry/node')

Sentry.init()

// persist Hue username and current state to disk so we can restore on restart
const DATA_PATH = '/data/hue.json'

const CONNECTED        = 'connected'
const NO_BRIDGES_FOUND = 'no_bridges_found'
const NO_LINK_PUSHED   = 'no_link_pushed'
const FAILURE          = 'fail'

// track day/night status
let isNight = undefined
// protect data file from being written simultaneously
let isWriting = false
let hue = null
// data to be persisted
let data = {
  hueUsername: null,
  sensorVals: {},
  sensorNames: {}
}

// attempt to read previous data cache, if it exists
if (fs.existsSync(DATA_PATH)) {
  const dataFile = fs.readFileSync(DATA_PATH)
  data = {...data, ...JSON.parse(dataFile)}
}

// cache data file to disk because we don't want lights to turn on if system reboots in middle of night
function persistDataFile() {
  if (!isWriting) {
    isWriting = true
    fs.writeFile(DATA_PATH, JSON.stringify(data), function(err) {
      isWriting = false
    })
  }
}

function saveUsername(name) {
  data.hueUsername = name
  persistDataFile()
}

function sensorValChanged(sensorId, sensorName, occupied) {
  if (data.sensorVals[sensorId] === occupied) return false
  
  data.sensorVals[sensorId] = occupied
  data.sensorNames[sensorName] = sensorId
  persistDataFile()

  return true
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
    hiome.publish('_hiome/integrate/hue', JSON.stringify({status, host: hue && hue.host}), {qos: 1, retain: true})
  else
    hiome.publish('_hiome/integrate/hue', '', {retain: true})
}

hiome.on('connect', function() {
  hiome.subscribe('_hiome/integrate/hue', {qos: 1})
  hiome.subscribe('hiome/1/sensor/#', {qos: 1})
  connect() // connect to hue bridge now that we're ready
})

hiome.on('message', function(topic, msg, packet) {
  if (msg.length === 0) return
  if (topic === '_hiome/integrate/hue') {
    if (msg.toString() === 'connect') connect()
    else if (msg.toString() === 'disconnect') disconnect()
  } else if (hue) {
    const message = JSON.parse(msg.toString())
    if (message['meta'] && message['meta']['type'] === 'occupancy' && message['meta']['source'] === 'gateway') {
      const sensorId = message['meta']['room']
      const sensorName = sanitizeName(message['meta']['name'].replace('Occupancy', ''))
      const occupied = message['val'] > 0 

      // only do something if the occupancy state of the room is changing
      if (!sensorValChanged(sensorId, sensorName, occupied)) return

      hue.groups.getAll()
        .then(groups => {
          for (let group of groups) {
            const santizedGroupName = sanitizeName(group.name)
            if (isNight && santizedGroupName === sensorName) {
              group.on = occupied
              return hue.groups.save(group)
            } else if (!isNight && santizedGroupName === `${sensorName} Daytime`) {
              group.on = occupied
              return hue.groups.save(group)
            }
          }
        })
        .catch(error => Sentry.captureException(error))
    } else if (message['meta'] && message['meta']['type'] === 'solar' && message['meta']['name'] === 'Sun') {
      const wasNight = isNight
      isNight = message['val'] === 'sunset'
      if (wasNight === undefined || isNight === wasNight) return

      hue.groups.getAll()
        .then(groups => {
          for (let group of groups) {
            const santizedGroupName = sanitizeName(group.name)
            if (isNight && santizedGroupName in data.sensorNames) {
              group.on = data.sensorVals[data.sensorNames[santizedGroupName]]
              return hue.groups.save(group)
            } else if (!isNight && santizedGroupName in data.sensorNames.map(s => `${s} Daytime`)) {
              group.on = data.sensorVals[data.sensorNames[santizedGroupName.replace(' Daytime', '')]]
              return hue.groups.save(group)
            }
          }
        })
        .catch(error => Sentry.captureException(error))
    }
  }
})