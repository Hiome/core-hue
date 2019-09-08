# Hiome Hue

Integrate Hue with Hiome, and directly control Hue lights based on your Hiome occupancy.

## Install

1. `git clone https://github.com/Hiome/hiome-hue.git`
2. `npm install`
3. Push the link button on your Hue bridge to pair it with Hiome
4. `npm start`

## Setup

This script assumes that you have Hue groups with the same name as the room in Hiome. For example, when "Bedroom" is occupied in Hiome, this script will attempt to turn on the "Bedroom" group in Hue. When the "Bedroom" is no longer occupied, it will turn off the "Bedroom" group.

## TODO

* Retry if Hue API fails?
