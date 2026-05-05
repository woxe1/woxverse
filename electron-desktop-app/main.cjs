const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
let mainWindow = null
let localBackendProcess = null
let localBackendConfigKey = null

function getBackendConfigPath() {
  return path.join(app.getPath('userData'), 'backend-config.json')
}

function readBackendConfig() {
  try {
    return JSON.parse(fs.readFileSync(getBackendConfigPath(), 'utf8'))
  } catch {
    return null
  }
}

function writeBackendConfig(config) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(getBackendConfigPath(), JSON.stringify(config, null, 2))
  return config
}

function getProjectMetadataPath(projectPath) {
  return path.join(projectPath, '.woxverse', 'project.json')
}

function readProjectMetadata(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(getProjectMetadataPath(projectPath), 'utf8'))
  } catch {
    return null
  }
}

function writeProjectMetadata(projectPath, metadata) {
  const metadataDirectory = path.dirname(getProjectMetadataPath(projectPath))
  fs.mkdirSync(metadataDirectory, { recursive: true })
  fs.writeFileSync(getProjectMetadataPath(projectPath), JSON.stringify(metadata, null, 2))
}

function slugify(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return slug || 'section'
}

function listLocalProjects(projectsPath) {
  if (!projectsPath || !fs.existsSync(projectsPath)) {
    return []
  }

  return fs
    .readdirSync(projectsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const projectPath = path.join(projectsPath, entry.name)
      const metadata = readProjectMetadata(projectPath)

      return {
        id: metadata?.id || entry.name,
        name: metadata?.name || entry.name.replace(/-/g, ' '),
        path: projectPath,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function createLocalProject(projectsPath, projectName) {
  const baseName = slugify(projectName)
  let projectDirectoryName = baseName
  let counter = 1

  while (fs.existsSync(path.join(projectsPath, projectDirectoryName))) {
    counter += 1
    projectDirectoryName = `${baseName}-${counter}`
  }

  const projectPath = path.join(projectsPath, projectDirectoryName)
  const project = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: projectName.trim() || 'Untitled project',
    path: projectPath,
  }

  fs.mkdirSync(projectPath, { recursive: true })
  writeProjectMetadata(projectPath, {
    id: project.id,
    name: project.name,
    createdAt: new Date().toISOString(),
  })

  return project
}

function parseSectionDirectoryName(directoryName) {
  const match = directoryName.match(/^(\d+)-(.+)--(.+)$/)

  if (!match) {
    return { order: 9999, title: directoryName.replace(/-/g, ' '), id: directoryName }
  }

  return {
    order: Number(match[1]),
    title: match[2].replace(/-/g, ' '),
    id: match[3],
  }
}

function sanitizeFilename(filename) {
  const parsedPath = path.parse(filename || 'image')
  const extension = parsedPath.ext.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase() || '.bin'

  return `${slugify(parsedPath.name)}${extension}`
}

function getSectionDirectory(parentDirectory, section, index) {
  return path.join(parentDirectory, `${String(index).padStart(2, '0')}-${slugify(section.title)}--${section.id}`)
}

function findSectionDirectory(parentDirectory, sectionId) {
  if (!fs.existsSync(parentDirectory)) {
    return null
  }

  return fs
    .readdirSync(parentDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(`--${sectionId}`))
    .map((entry) => path.join(parentDirectory, entry.name))
    .sort()[0] || null
}

function findSectionDirectoryRecursive(parentDirectory, sectionId) {
  const directMatch = findSectionDirectory(parentDirectory, sectionId)

  if (directMatch) {
    return directMatch
  }

  if (!fs.existsSync(parentDirectory)) {
    return null
  }

  for (const entry of fs.readdirSync(parentDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || parseSectionDirectoryName(entry.name).order === 9999) {
      continue
    }

    const match = findSectionDirectoryRecursive(path.join(parentDirectory, entry.name), sectionId)

    if (match) {
      return match
    }
  }

  return null
}

function scanDocumentSections(parentDirectory) {
  if (!fs.existsSync(parentDirectory)) {
    return []
  }

  return fs
    .readdirSync(parentDirectory, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory() || entry.name === 'assets' || entry.name === '.woxverse') {
        return false
      }

      return parseSectionDirectoryName(entry.name).order !== 9999
    })
    .sort((left, right) => parseSectionDirectoryName(left.name).order - parseSectionDirectoryName(right.name).order)
    .map((entry) => {
      const sectionDirectory = path.join(parentDirectory, entry.name)
      const sectionFile = path.join(sectionDirectory, 'index.md')
      const parsedDirectory = parseSectionDirectoryName(entry.name)

      return {
        id: parsedDirectory.id,
        title: parsedDirectory.title,
        content: fs.existsSync(sectionFile) ? fs.readFileSync(sectionFile, 'utf8') : '',
        children: scanDocumentSections(sectionDirectory),
      }
    })
}

function writeDocumentSections(parentDirectory, sections) {
  fs.mkdirSync(parentDirectory, { recursive: true })

  const activePaths = new Set()
  writeDocumentSectionsRecursive(parentDirectory, sections, activePaths)
  removeStaleDocumentEntries(parentDirectory, activePaths)
  return activePaths
}

function writeDocumentSectionsRecursive(parentDirectory, sections, activePaths) {
  sections.forEach((section, index) => {
    const previousDirectory = findSectionDirectory(parentDirectory, section.id)
    const sectionDirectory = getSectionDirectory(parentDirectory, section, index + 1)

    if (previousDirectory && previousDirectory !== sectionDirectory) {
      fs.renameSync(previousDirectory, sectionDirectory)
    }

    fs.mkdirSync(sectionDirectory, { recursive: true })
    const sectionFile = path.join(sectionDirectory, 'index.md')
    fs.writeFileSync(sectionFile, section.content || '', 'utf8')
    activePaths.add(sectionDirectory)
    activePaths.add(sectionFile)
    writeDocumentSectionsRecursive(sectionDirectory, section.children || [], activePaths)
  })
}

function removeStaleDocumentEntries(parentDirectory, activePaths) {
  if (!fs.existsSync(parentDirectory)) {
    return
  }

  for (const entry of fs.readdirSync(parentDirectory, { withFileTypes: true })) {
    const entryPath = path.join(parentDirectory, entry.name)

    if (entry.isFile() && entry.name.endsWith('.md') && !activePaths.has(entryPath)) {
      fs.unlinkSync(entryPath)
      continue
    }

    if (!entry.isDirectory() || parseSectionDirectoryName(entry.name).order === 9999) {
      continue
    }

    removeStaleDocumentEntries(entryPath, activePaths)

    if (!activePaths.has(entryPath) && fs.readdirSync(entryPath).length === 0) {
      fs.rmdirSync(entryPath)
    }
  }
}

function saveLocalDocumentAsset(projectPath, sectionId, filename, arrayBuffer) {
  const sectionDirectory = findSectionDirectoryRecursive(projectPath, sectionId)

  if (!sectionDirectory) {
    throw new Error('Section directory not found. Save the document before uploading assets.')
  }

  const assetsDirectory = path.join(sectionDirectory, 'assets')
  fs.mkdirSync(assetsDirectory, { recursive: true })

  const safeFilename = sanitizeFilename(filename)
  const parsedPath = path.parse(safeFilename)
  let destination = path.join(assetsDirectory, safeFilename)
  let counter = 1

  while (fs.existsSync(destination)) {
    destination = path.join(assetsDirectory, `${parsedPath.name}-${counter}${parsedPath.ext}`)
    counter += 1
  }

  fs.writeFileSync(destination, Buffer.from(arrayBuffer))

  return {
    relative_path: `assets/${path.basename(destination)}`,
    url: destination,
  }
}

function getBackendSourcePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend')
  }

  return path.join(__dirname, '..', 'fastapi-auth-service')
}

function getVenvPythonPath(venvPath) {
  return process.platform === 'win32'
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python')
}

function getPythonLauncherCandidates() {
  return process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    windowsHide: true,
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Command failed: ${command}`)
  }

  return result
}

function findPythonLauncher() {
  for (const command of getPythonLauncherCandidates()) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true })

    if (result.status === 0) {
      return command
    }
  }

  throw new Error('Python is required to start the local backend')
}

function ensureLocalBackendPython(backendPath) {
  const venvPath = path.join(app.getPath('userData'), 'local-backend-venv')
  const venvPythonPath = getVenvPythonPath(venvPath)
  const requirementsPath = path.join(backendPath, 'requirements.txt')
  const installMarkerPath = path.join(venvPath, '.requirements-installed')

  if (!fs.existsSync(venvPythonPath)) {
    runChecked(findPythonLauncher(), ['-m', 'venv', venvPath])
  }

  if (!fs.existsSync(installMarkerPath)) {
    runChecked(venvPythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip'])
    runChecked(venvPythonPath, ['-m', 'pip', 'install', '-r', requirementsPath])
    fs.writeFileSync(installMarkerPath, new Date().toISOString())
  }

  return venvPythonPath
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 8000
      server.close(() => resolve(port))
    })
  })
}

function waitForLocalBackend(apiUrl) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 12000

    async function check() {
      try {
        const response = await fetch(`${apiUrl}/health`)

        if (response.ok) {
          resolve()
          return
        }
      } catch {
        // Retry until the backend either becomes healthy or times out.
      }

      if (Date.now() > deadline) {
        reject(new Error('Local backend did not start'))
        return
      }

      setTimeout(check, 300)
    }

    check()
  })
}

function stopLocalBackend() {
  if (localBackendProcess) {
    localBackendProcess.kill()
    localBackendProcess = null
    localBackendConfigKey = null
  }
}

async function ensureLocalBackend(config) {
  if (config.mode !== 'local') {
    stopLocalBackend()
    return config
  }

  if (!config.activeProjectPath) {
    stopLocalBackend()
    return config
  }

  const projectsPath = config.activeProjectPath

  if (!projectsPath) {
    return config
  }

  const documentsPath = projectsPath
  const metadataPath = path.join(projectsPath, '.woxverse')
  const sqlitePath = path.join(metadataPath, 'graphs.sqlite')
  const backendKey = `${projectsPath}|${documentsPath}|${sqlitePath}`

  if (localBackendProcess && localBackendConfigKey === backendKey && config.apiUrl) {
    return config
  }

  stopLocalBackend()
  fs.mkdirSync(documentsPath, { recursive: true })
  fs.mkdirSync(metadataPath, { recursive: true })

  const port = await findAvailablePort()
  const apiUrl = `http://127.0.0.1:${port}`
  const backendPath = getBackendSourcePath()
  const pythonPath = ensureLocalBackendPython(backendPath)

  localBackendProcess = spawn(pythonPath, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: backendPath,
    env: {
      ...process.env,
      AUTH_LOGIN: process.env.AUTH_LOGIN || 'admin@mail.ru',
      AUTH_PASSWORD: process.env.AUTH_PASSWORD || '123',
      CORS_ORIGINS: process.env.CORS_ORIGINS || '*',
      DOCUMENTS_PATH: documentsPath,
      SQLITE_PATH: sqlitePath,
      WOXVERSE_LOCAL_DOCUMENT_ROOT: '1',
      WOXVERSE_LOCAL_MODE: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  localBackendConfigKey = backendKey

  localBackendProcess.once('exit', () => {
    localBackendProcess = null
    localBackendConfigKey = null
  })

  await waitForLocalBackend(apiUrl)

  return {
    ...config,
    apiUrl,
    documentsPath,
    sqlitePath,
  }
}

function getRendererEntryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'renderer', 'index.html')
  }

  return path.join(__dirname, '..', 'react-ts-app', 'dist', 'index.html')
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#0b1018',
    autoHideMenuBar: true,
    title: 'Woxverse',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    return
  }

  mainWindow.loadFile(getRendererEntryPath())
}

app.whenReady().then(() => {
  ipcMain.handle('backend-config:get', async () => {
    const config = readBackendConfig()

    return config ? ensureLocalBackend(config) : null
  })

  ipcMain.handle('backend-config:save', async (_event, config) => {
    const nextConfig = await ensureLocalBackend(config)
    writeBackendConfig(config)
    return nextConfig
  })

  ipcMain.handle('projects-directory:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select projects directory',
      properties: ['openDirectory', 'createDirectory'],
    })

    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('local-projects:list', (_event, projectsPath) => listLocalProjects(projectsPath))

  ipcMain.handle('local-projects:create', (_event, projectsPath, projectName) =>
    createLocalProject(projectsPath, projectName),
  )

  ipcMain.handle('local-document:load', (_event, projectsPath) => {
    return {
      sections: scanDocumentSections(projectsPath),
    }
  })

  ipcMain.handle('local-document:save', (_event, projectsPath, document) => {
    writeDocumentSections(projectsPath, document.sections || [])
    return document
  })

  ipcMain.handle('local-document:save-asset', (_event, projectPath, sectionId, filename, arrayBuffer) =>
    saveLocalDocumentAsset(projectPath, sectionId, filename, arrayBuffer),
  )

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopLocalBackend()
})
