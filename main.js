#!/usr/bin/env node

const huejay = require('huejay')
const mqtt = require('mqtt')
const fs = require('fs');

// persist Hue username and current state to disk so we can restore on restart
const DATA_PATH = 'hue.json'
// track day/night status
let isNight = undefined
// protect data file from being written simultaneously
let isWriting = false
// data to be persisted
let data = {
  hueUsername: null,
  sensorVals: {},
  sensorNames: {}
}

// attempt to read previous data cache, if it exists
if (fs.existsSync(DATA_PATH)) {
  const dataFile = fs.readFileSync(DATA_PATH)
  data = JSON.parse(dataFile)
}

// start scanning for a Hue bridge
scanBridges()

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

// discover bridges via UPnP and N-UPnP
function scanBridges() {
  if (!data.hueUsername) console.log("Press the Link button on the Hue bridge to put it in pairing mode!")
  console.log("Scanning for bridges...")
  huejay.discover({strategy: 'all'})
    .then(validateBridges)
    .catch(error => {
      console.log(`An error occurred: ${error.message}`)
      // wait 30 seconds and scan again
      setTimeout(scanBridges, 30000)
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
    if (bridgesFrd.length == 0) {
      console.log("No hue bridges found... Trying again in 30 seconds")
      // wait 30 seconds and scan again
      setTimeout(scanBridges, 30000)
    } else if (bridgesFrd.length == 1) {
      authenticateUser(bridgesFrd[0])
    } else {
      // too many bridges found, but maybe we can authenticate with one of them
      const authenticated = bridgesFrd.map(bridge => {
        return new huejay.Client({host: bridge.ip, username: data.hueUsername}).bridge.isAuthenticated()
          .then(() => bridge.ip)
          .catch(error => null)
      })

      Promise.all(authenticated).then(authenticatable => {
        const authenticatableFrd = authenticatable.filter(x => x)
        if (authenticatableFrd.length == 1) {
          // success!
          scanHiome(authenticatableFrd[0])
        } else {
          // nope, can't authenticate with any of them :(
          console.log("Too many hue bridges found, I don't know what to do. Halp.")
          // wait 30 seconds and scan again
          setTimeout(scanBridges, 30000)
        }
      })
    }
  })
}

// check existing user or create new user if needed
function authenticateUser(bridgeIp) {
  if (data.hueUsername && new huejay.Client({host: bridgeIp, username: data.hueUsername}).bridge.isAuthenticated()) {
    // we already know the user ID and it successfully authenticates
    return scanHiome(bridgeIp)
  }

  const client = new huejay.Client({host: bridgeIp})
  let user = new client.users.User
  user.deviceType = 'Hiome'

  client.users.create(user)
    .then(user => {
      saveUsername(user.username)
      scanHiome(bridgeIp)
    })
    .catch(error => {
      if (error instanceof huejay.Error && error.type === 101)
        console.log("Link button not pressed. Trying again in 30 seconds...")
      else
        console.log(error.stack)

      // wait 30 seconds and scan again
      setTimeout(scanBridges, 30000)
    })
}

// clean out punctuation and spaces from room names
function sanitizeName(str) {
  return str.replace(/[^\w\s_\-]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
}

// now we can finally get started...
function scanHiome(bridgeIp) {
  const hue = new huejay.Client({host: bridgeIp, username: data.hueUsername})
  const hiome = mqtt.connect('mqtt://hiome.local')

  hiome.on('connect', function() {
    hiome.subscribe('hiome/1/sensor/#', {qos: 1})
  })

  hiome.on('message', function(topic, msg, packet) {
    if (msg.length === 0) return
    const message = JSON.parse(msg)
    if (message['meta'] && message['meta']['type'] === 'occupancy' && message['meta']['source'] === 'gateway') {
      const sensorId = message['meta']['room']
      const sensorName = sanitizeName(message['meta']['name'].replace('Occupancy', ''))
      const occupied = message['val'] > 0 

      // only do something if the occupancy state of the room is changing
      if (!sensorValChanged(sensorId, sensorName, occupied)) return

      hue.groups.getAll()
        .then(groups => {
          for (let group of groups) {
            if (sanitizeName(group.name) === sensorName) {
              group.on = /*isNight &&*/ occupied
              return hue.groups.save(group)
            }
          }
          console.log("No Hue group found for", sensorName)
        })
        .catch(error => {
          console.log("Hue API Failure")
          console.log(error.stack)
        })
    } else if (message['meta'] && message['meta']['type'] === 'solar' && message['meta']['name'] === 'Sun') {
      const wasNight = isNight
      isNight = message['val'] === 'sunset'
      if (wasNight === undefined || isNight === wasNight) return

      hue.groups.getAll()
        .then(groups => {
          for (let group of groups) {
            const santizedGroupName = sanitizeName(group.name)
            if (santizedGroupName in data.sensorNames) {
              group.on = isNight && data.sensorVals[data.sensorNames[santizedGroupName]]
              hue.groups.save(group)
            }
          }
        })
        .catch(error => {
          console.log("Hue API Failure")
          console.log(error.stack)
        })
    }
  })
}
