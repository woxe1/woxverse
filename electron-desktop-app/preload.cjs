const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('woxverseDesktop', {
  platform: process.platform,
})
