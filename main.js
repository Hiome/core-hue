#!/usr/bin/env node

const huejay = require('huejay')
const mqtt = require('mqtt')
const fs = require('fs');

// persist Hue username and current state to disk so we can restore on restart
const DATA_PATH = 'hue.json'
// don't start a new scan while current one is ongoing
let canScan = true
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

// scan every 30 seconds until we find a bridge
const scanInterval = setInterval(scanBridges, 30000)
// and start scanning for bridge immediately on launch
scanBridges()

function saveUsername(name) {
  data.hueUsername = name
  if (!isWriting) {
    isWriting = true
    fs.writeFile(DATA_PATH, JSON.stringify(data), function(err) {
      isWriting = false
    })
  }
}

function sensorValChanged(sensorId, sensorName, occupied) {
  if (data.sensorVals[sensorId] === occupied) return false
  
  data.sensorVals[sensorId] = occupied
  data.sensorNames[sensorName] = sensorId
  if (!isWriting) {
    isWriting = true
    fs.writeFile(DATA_PATH, JSON.stringify(data), function(err) {
      isWriting = false
    })
  }

  return true
}

function scanBridges() {
  if (!canScan) return
  canScan = false
  console.log("Scanning for bridges... Press the Link button on the Hue bridge if this is your first time running this script!")
  huejay.discover({strategy: 'all'})
    .then(validateBridges)
    .catch(error => {
      console.log(`An error occurred: ${error.message}`)
    })
}

function validateBridges(bridges) {
  const promises = bridges.map(bridge => {
    return new huejay.Client({host: bridge.ip}).bridge.ping()
      .then(() => bridge.ip)
      .catch(error => null)
  })

  Promise.all(promises).then(pingables => {
    const bridgesFrd = pingables.filter(x => x)
    if (bridgesFrd.length == 0) {
      console.log("No hue bridges found...")
      canScan = true
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
          canScan = true
        }
      })
    }
  })
}

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
        console.log("Link button not pressed. Try again...")
      else
        console.log(error.stack)

      canScan = true
    })
}

function sanitizeName(str) {
  return str.replace(/[^\w\s_\-]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
}

// now we can finally get started...
function scanHiome(bridgeIp) {
  clearInterval(scanInterval)
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
              group.on = isNight && occupied
              hue.groups.save(group)
              break
            }
          }
        })
        .catch(error => {
          console.log("Failed to fetch Hue groups")
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
          console.log("Failed to fetch Hue groups")
        })
    }
  })
}
