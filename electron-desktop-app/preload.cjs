const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('woxverseDesktop', {
  platform: process.platform,
  getBackendConfig: () => ipcRenderer.invoke('backend-config:get'),
  saveBackendConfig: (config) => ipcRenderer.invoke('backend-config:save', config),
  selectProjectsDirectory: () => ipcRenderer.invoke('projects-directory:select'),
  listLocalProjects: (projectsPath) => ipcRenderer.invoke('local-projects:list', projectsPath),
  createLocalProject: (projectsPath, projectName) => ipcRenderer.invoke('local-projects:create', projectsPath, projectName),
  loadLocalDocument: (projectsPath) => ipcRenderer.invoke('local-document:load', projectsPath),
  saveLocalDocument: (projectsPath, document) => ipcRenderer.invoke('local-document:save', projectsPath, document),
  saveLocalDocumentAsset: (projectPath, sectionId, filename, arrayBuffer) =>
    ipcRenderer.invoke('local-document:save-asset', projectPath, sectionId, filename, arrayBuffer),
})
