import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import type {
  CSSProperties,
  ChangeEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent,
  WheelEvent,
} from 'react'
import { Terminal } from 'xterm'
import './App.css'
import 'xterm/css/xterm.css'

type LoginState = 'idle' | 'loading' | 'success' | 'error'
type SaveState = 'idle' | 'loading' | 'success' | 'error'
type WorkspaceMode = 'graph' | 'docs'

type LoginResponse = {
  authenticated: boolean
  token: string
}

type UserSession = {
  username: string
  token: string
}

type GraphNode = {
  id: string
  label: string
  x: number
  y: number
  document_section_id?: string | null
}

type GraphEdge = {
  id: string
  source: string
  target: string
  label: string
}

type GraphData = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

type DocSection = {
  id: string
  title: string
  content: string
  children: DocSection[]
}

type DocumentData = {
  sections: DocSection[]
}

type AssetUploadResponse = {
  relative_path: string
  url: string
}

type SectionOption = {
  id: string
  title: string
  depth: number
}

type DocBlockType = 'text' | 'heading' | 'image' | 'code' | 'quote' | 'playground' | 'terminal'
type TextFont = 'default' | 'serif' | 'mono' | 'display'

type DocBlock = {
  id: string
  type: DocBlockType
  value: string
  font?: TextFont
}

type SlashCommand = {
  type: DocBlockType
  label: string
  hint: string
}

type PlaygroundRunResponse = {
  success: boolean
  exit_code: number
  stdout: string
  stderr: string
}

type TerminalBlockConfig = {
  connectionString: string
  host: string
  port: string
  username: string
  password: string
}

type TerminalOpenResponse = {
  session_id: string
  host: string
  port: number
  username: string
}

type Point = {
  x: number
  y: number
}

type PanDrag = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
}

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
const graphName = 'default'
const documentName = 'default'
const sessionStorageKey = 'woxverse-session'
const textFontOptions: Array<{ value: TextFont; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Mono' },
  { value: 'display', label: 'Display' },
]
const slashCommands: SlashCommand[] = [
  { type: 'text', label: 'Text', hint: 'Plain markdown text' },
  { type: 'heading', label: 'H1', hint: 'Large section heading' },
  { type: 'image', label: 'Image', hint: 'Upload and insert a photo' },
  { type: 'code', label: 'Code', hint: 'Highlighted code block' },
  { type: 'playground', label: 'Playground', hint: 'Run Python code inline' },
  { type: 'terminal', label: 'Terminal', hint: 'Open an SSH terminal' },
  { type: 'quote', label: 'Quote', hint: 'Callout quote text' },
]

function createId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function findSection(sections: DocSection[], sectionId: string | null): DocSection | null {
  if (!sectionId) {
    return null
  }

  for (const section of sections) {
    if (section.id === sectionId) {
      return section
    }

    const child = findSection(section.children, sectionId)

    if (child) {
      return child
    }
  }

  return null
}

function countSections(sections: DocSection[]): number {
  return sections.reduce((total, section) => total + 1 + countSections(section.children), 0)
}

function flattenSections(sections: DocSection[], depth = 0): SectionOption[] {
  return sections.flatMap((section) => [
    {
      id: section.id,
      title: section.title || 'Untitled',
      depth,
    },
    ...flattenSections(section.children, depth + 1),
  ])
}

function filterSectionsByQuery(sections: DocSection[], query: string): DocSection[] {
  const normalizedQuery = query.trim().toLowerCase()

  if (!normalizedQuery) {
    return sections
  }

  return sections.reduce<DocSection[]>((matches, section) => {
    const matchingChildren = filterSectionsByQuery(section.children, normalizedQuery)
    const haystack = `${section.title}\n${section.content}`.toLowerCase()

    if (haystack.includes(normalizedQuery) || matchingChildren.length > 0) {
      matches.push({
        ...section,
        children: matchingChildren,
      })
    }

    return matches
  }, [])
}

function getNodeRadius(label: string): number {
  return Math.max(30, Math.min(82, label.length * 4.2 + 16))
}

function createDefaultTerminalConfig(): TerminalBlockConfig {
  return {
    connectionString: '',
    host: '',
    port: '22',
    username: '',
    password: '',
  }
}

function parseTerminalBlockConfig(value: string): TerminalBlockConfig {
  if (!value.trim()) {
    return createDefaultTerminalConfig()
  }

  try {
    const parsed = JSON.parse(value) as Partial<TerminalBlockConfig>

    return {
      connectionString: parsed.connectionString ?? '',
      host: parsed.host ?? '',
      port: parsed.port ?? '22',
      username: parsed.username ?? '',
      password: parsed.password ?? '',
    }
  } catch {
    return createDefaultTerminalConfig()
  }
}

function stringifyTerminalBlockConfig(config: TerminalBlockConfig): string {
  return JSON.stringify(config, null, 2)
}

function getTerminalWebSocketUrl(apiBaseUrl: string, sessionId: string, token: string): string {
  const url = new URL(apiBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/terminal/sessions/${sessionId}/ws`
  url.searchParams.set('token', token)
  return url.toString()
}

function resizeTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

function normalizeTextFont(value: string | undefined): TextFont {
  return textFontOptions.some((option) => option.value === value) ? (value as TextFont) : 'default'
}

function splitMarkdownBlocks(content: string): string[] {
  const blocks: string[] = []
  const lines = content.split('\n')
  let current: string[] = []
  let inFontBlock = false
  let inCodeBlock = false

  function pushCurrentBlock() {
    const value = current.join('\n').trim()

    if (value) {
      blocks.push(value)
    }

    current = []
  }

  for (const line of lines) {
    if (!inFontBlock && line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        pushCurrentBlock()
        inCodeBlock = true
        current.push(line)
        continue
      }

      current.push(line)
      inCodeBlock = false
      pushCurrentBlock()
      continue
    }

    if (inCodeBlock) {
      current.push(line)
      continue
    }

    if (!inFontBlock && /^<div\s+data-font="[^"]+">\s*$/.test(line.trim())) {
      pushCurrentBlock()
      inFontBlock = true
      current.push(line)
      continue
    }

    if (inFontBlock) {
      current.push(line)

      if (line.trim() === '</div>') {
        inFontBlock = false
        pushCurrentBlock()
      }

      continue
    }

    if (!line.trim()) {
      pushCurrentBlock()
      continue
    }

    current.push(line)
  }

  pushCurrentBlock()
  return blocks
}

function parseMarkdownBlocks(content: string): DocBlock[] {
  if (!content.trim()) {
    return []
  }

  return splitMarkdownBlocks(content)
    .map((block): DocBlock => {
      const trimmedBlock = block.trim()
      const fontMatch = trimmedBlock.match(/^<div\s+data-font="([^"]+)">\n?([\s\S]*?)\n?<\/div>$/)
      const imageMatch = trimmedBlock.match(/^!\[[^\]]*]\((.*)\)$/)

      if (fontMatch) {
        return {
          id: createId(),
          type: 'text',
          value: fontMatch[2],
          font: normalizeTextFont(fontMatch[1]),
        }
      }

      if (imageMatch) {
        return { id: createId(), type: 'image', value: imageMatch[1] }
      }

      if (trimmedBlock.startsWith('```') && trimmedBlock.endsWith('```')) {
        if (trimmedBlock.startsWith('```terminal')) {
          return {
            id: createId(),
            type: 'terminal',
            value: trimmedBlock.replace(/^```terminal\s*\n?/, '').replace(/\n?```$/, ''),
          }
        }

        if (trimmedBlock.startsWith('```playground')) {
          return {
            id: createId(),
            type: 'playground',
            value: trimmedBlock.replace(/^```playground\s*\n?/, '').replace(/\n?```$/, ''),
          }
        }

        return {
          id: createId(),
          type: 'code',
          value: trimmedBlock.replace(/^```\w*\n?/, '').replace(/\n?```$/, ''),
        }
      }

      if (trimmedBlock.startsWith('# ')) {
        return { id: createId(), type: 'heading', value: trimmedBlock.replace(/^# /, '') }
      }

      if (trimmedBlock.startsWith('> ')) {
        return {
          id: createId(),
          type: 'quote',
          value: trimmedBlock
            .split('\n')
            .map((line) => line.replace(/^> ?/, ''))
            .join('\n'),
        }
      }

      return { id: createId(), type: 'text', value: trimmedBlock, font: 'default' }
    })
}

function serializeMarkdownBlocks(blocks: DocBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'heading') {
        return `# ${block.value}`
      }

      if (block.type === 'image') {
        return block.value ? `![Image](${block.value})` : ''
      }

      if (block.type === 'code') {
        return `\`\`\`\n${block.value}\n\`\`\``
      }

      if (block.type === 'playground') {
        return `\`\`\`playground\n${block.value}\n\`\`\``
      }

      if (block.type === 'terminal') {
        return `\`\`\`terminal\n${block.value}\n\`\`\``
      }

      if (block.type === 'quote') {
        return block.value
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      }

      if (block.type === 'text' && block.font && block.font !== 'default') {
        return `<div data-font="${block.font}">\n${block.value}\n</div>`
      }

      return block.value
    })
    .filter(Boolean)
    .join('\n\n')
}

function getImagePreviewUrl(documentName: string, sectionId: string | null, value: string): string {
  if (!sectionId || !value) {
    return ''
  }

  if (/^https?:\/\//.test(value) || value.startsWith('data:')) {
    return value
  }

  const filename = value.replace(/^assets\//, '')
  return `${apiUrl}/documents/${documentName}/sections/${sectionId}/assets/${encodeURIComponent(filename)}`
}

function highlightCode(value: string) {
  const tokenPattern =
    /(\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b\d+(?:\.\d+)?\b|\b(?:and|as|async|await|break|case|catch|class|const|continue|def|else|export|False|false|finally|for|from|function|if|import|in|interface|is|lambda|let|new|None|null|not|or|return|self|throw|true|True|try|type|undefined|var|while|with|yield)\b)/g

  return value.split(tokenPattern).map((part, index) => {
    if (!part) {
      return null
    }

    let className = ''

    if (/^(\/\/|\/\*)/.test(part)) {
      className = 'token-comment'
    } else if (/^["'`]/.test(part)) {
      className = 'token-string'
    } else if (/^\d/.test(part)) {
      className = 'token-number'
    } else if (/^[a-zA-Z_]/.test(part)) {
      className = 'token-keyword'
    }

    return className ? (
      <span className={className} key={`${part}-${index}`}>
        {part}
      </span>
    ) : (
      part
    )
  })
}

function buildBlocksBySectionId(sections: DocSection[]): Record<string, DocBlock[]> {
  return sections.reduce<Record<string, DocBlock[]>>((blocksBySectionId, section) => {
    return {
      ...blocksBySectionId,
      [section.id]: parseMarkdownBlocks(section.content),
      ...buildBlocksBySectionId(section.children),
    }
  }, {})
}

function updateSectionTree(
  sections: DocSection[],
  sectionId: string,
  update: (section: DocSection) => DocSection,
): DocSection[] {
  return sections.map((section) => {
    if (section.id === sectionId) {
      return update(section)
    }

    return {
      ...section,
      children: updateSectionTree(section.children, sectionId, update),
    }
  })
}

function collectSectionIds(section: DocSection): string[] {
  return [section.id, ...section.children.flatMap(collectSectionIds)]
}

function removeSectionFromTree(
  sections: DocSection[],
  sectionId: string,
): { nextSections: DocSection[]; removedSection: DocSection | null } {
  let removedSection: DocSection | null = null

  const nextSections = sections
    .filter((section) => {
      if (section.id === sectionId) {
        removedSection = section
        return false
      }

      return true
    })
    .map((section) => {
      if (removedSection) {
        return section
      }

      const result = removeSectionFromTree(section.children, sectionId)

      if (result.removedSection) {
        removedSection = result.removedSection
        return {
          ...section,
          children: result.nextSections,
        }
      }

      return section
    })

  return { nextSections, removedSection }
}

function loadStoredSession(): UserSession | null {
  try {
    const storedSession = localStorage.getItem(sessionStorageKey)
    const parsedSession = storedSession ? (JSON.parse(storedSession) as Partial<UserSession>) : null

    if (!parsedSession?.username || !parsedSession.token) {
      localStorage.removeItem(sessionStorageKey)
      return null
    }

    return {
      username: parsedSession.username,
      token: parsedSession.token,
    }
  } catch {
    localStorage.removeItem(sessionStorageKey)
    return null
  }
}

type TerminalBlockProps = {
  blockId: string
  value: string
  session: UserSession | null
  onChange: (value: string) => void
}

function TerminalBlock({ blockId, value, session, onChange }: TerminalBlockProps) {
  const config = useMemo(() => parseTerminalBlockConfig(value), [value])
  const [connectionState, setConnectionState] = useState<'idle' | 'opening' | 'open'>('idle')
  const [connectionMessage, setConnectionMessage] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const terminalContainerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      fontSize: 13,
      lineHeight: 1.35,
      theme: {
        background: '#05070c',
        foreground: '#d7e2f2',
        cursor: '#24d3ee',
        selectionBackground: 'rgba(36, 211, 238, 0.25)',
      },
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(terminalContainerRef.current)
    fitAddon.fit()
    terminal.writeln('Terminal is ready. Fill connection details and press Open.')

    terminal.onData((data) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(data)
      }
    })

    const handleResize = () => fitAddon.fit()
    window.addEventListener('resize', handleResize)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    return () => {
      window.removeEventListener('resize', handleResize)
      socketRef.current?.close()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (sessionId && session) {
        fetch(`${apiUrl}/terminal/sessions/${sessionId}/close`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.token}`,
          },
        }).catch(() => undefined)
      }
    }
  }, [session, sessionId])

  function updateTerminalField(field: keyof TerminalBlockConfig, nextValue: string) {
    onChange(
      stringifyTerminalBlockConfig({
        ...config,
        [field]: nextValue,
      }),
    )
  }

  async function closeTerminal() {
    socketRef.current?.close()
    socketRef.current = null

    if (sessionId && session) {
      try {
        await fetch(`${apiUrl}/terminal/sessions/${sessionId}/close`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.token}`,
          },
        })
      } catch {
        // keep local terminal state consistent even if close request fails
      }
    }

    setSessionId(null)
    setConnectionState('idle')
    setConnectionMessage('')
    terminalRef.current?.writeln('\r\n[session closed]')
  }

  async function openTerminal() {
    if (!session) {
      return
    }

    setConnectionState('opening')
    setConnectionMessage('')

    try {
      const response = await fetch(`${apiUrl}/terminal/sessions/open`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connection_string: config.connectionString,
          host: config.host,
          port: Number(config.port || '22'),
          username: config.username,
          password: config.password,
        }),
      })

      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as { detail?: string } | null
        throw new Error(errorPayload?.detail ?? 'Unable to open terminal')
      }

      const data = (await response.json()) as TerminalOpenResponse
      const socket = new WebSocket(getTerminalWebSocketUrl(apiUrl, data.session_id, session.token))

      socket.onopen = () => {
        setSessionId(data.session_id)
        setConnectionState('open')
        setConnectionMessage(`${data.username}@${data.host}:${data.port}`)
        terminalRef.current?.clear()
        terminalRef.current?.writeln(`[connected to ${data.username}@${data.host}:${data.port}]`)
        fitAddonRef.current?.fit()
      }

      socket.onmessage = (event) => {
        terminalRef.current?.write(event.data)
      }

      socket.onclose = () => {
        socketRef.current = null
        setSessionId(null)
        setConnectionState('idle')
      }

      socket.onerror = () => {
        setConnectionState('idle')
        setConnectionMessage('Terminal connection failed')
      }

      socketRef.current = socket
    } catch (error) {
      setConnectionState('idle')
      setConnectionMessage(error instanceof Error ? error.message : 'Unable to open terminal')
    }
  }

  return (
    <div className="terminal-editor">
      <div className="terminal-config-grid">
        <input
          data-block-id={blockId}
          className="terminal-config-input terminal-connection-string"
          type="text"
          value={config.connectionString}
          placeholder="ssh://user:password@host:22"
          onChange={(event) => updateTerminalField('connectionString', event.target.value)}
        />
        <input
          className="terminal-config-input"
          type="text"
          value={config.host}
          placeholder="Host / IP"
          onChange={(event) => updateTerminalField('host', event.target.value)}
        />
        <input
          className="terminal-config-input"
          type="text"
          value={config.port}
          placeholder="Port"
          onChange={(event) => updateTerminalField('port', event.target.value)}
        />
        <input
          className="terminal-config-input"
          type="text"
          value={config.username}
          placeholder="Login"
          onChange={(event) => updateTerminalField('username', event.target.value)}
        />
        <input
          className="terminal-config-input"
          type="password"
          value={config.password}
          placeholder="Password"
          onChange={(event) => updateTerminalField('password', event.target.value)}
        />
      </div>

      <div className="terminal-toolbar">
        <span className="terminal-badge">SSH terminal</span>
        <div className="terminal-toolbar-actions">
          {connectionMessage ? <span className="terminal-connection-state">{connectionMessage}</span> : null}
          {connectionState === 'open' ? (
            <button className="terminal-close-button" type="button" onClick={closeTerminal}>
              Close
            </button>
          ) : (
            <button className="terminal-open-button" type="button" onClick={openTerminal}>
              {connectionState === 'opening' ? 'Opening...' : 'Open'}
            </button>
          )}
        </div>
      </div>

      <div className="terminal-surface" ref={terminalContainerRef} />
    </div>
  )
}

function App() {
  const canvasRef = useRef<SVGSVGElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('graph')
  const [loginState, setLoginState] = useState<LoginState>('idle')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [docSaveState, setDocSaveState] = useState<SaveState>('idle')
  const [message, setMessage] = useState('')
  const [graphMessage, setGraphMessage] = useState('')
  const [docMessage, setDocMessage] = useState('')
  const [session, setSession] = useState<UserSession | null>(() => loadStoredSession())
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [panDrag, setPanDrag] = useState<PanDrag | null>(null)
  const [sections, setSections] = useState<DocSection[]>([])
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null)
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null)
  const [sectionSearch, setSectionSearch] = useState('')
  const [docBlocksBySectionId, setDocBlocksBySectionId] = useState<Record<string, DocBlock[]>>({})
  const [playgroundOutputByBlockId, setPlaygroundOutputByBlockId] = useState<Record<string, PlaygroundRunResponse>>({})
  const [playgroundRunStateByBlockId, setPlaygroundRunStateByBlockId] = useState<Record<string, 'idle' | 'running'>>({})
  const [pendingImageInsertIndex, setPendingImageInsertIndex] = useState<number | null>(null)
  const [pendingImageBlockId, setPendingImageBlockId] = useState<string | null>(null)
  const [slashMenuBlockId, setSlashMenuBlockId] = useState<string | null>(null)
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null)

  const selectedNodes = useMemo(
    () => nodes.filter((node) => selectedNodeIds.includes(node.id)),
    [nodes, selectedNodeIds],
  )
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null
  const selectedSection = findSection(sections, selectedSectionId)
  const sectionOptions = useMemo(() => flattenSections(sections), [sections])
  const filteredSections = useMemo(
    () => filterSectionsByQuery(sections, sectionSearch),
    [sectionSearch, sections],
  )
  const filteredSectionCount = useMemo(() => countSections(filteredSections), [filteredSections])
  const selectedSectionBlocks = selectedSectionId ? docBlocksBySectionId[selectedSectionId] ?? [] : []
  const shouldRenderTrailingPlaceholder =
    selectedSectionBlocks.length === 0 ||
    selectedSectionBlocks[selectedSectionBlocks.length - 1]?.type !== 'text' ||
    selectedSectionBlocks[selectedSectionBlocks.length - 1]?.value.trim() !== ''
  const linkedSection = selectedNode
    ? findSection(sections, selectedNode.document_section_id ?? null)
    : null

  function expireSession() {
    localStorage.removeItem(sessionStorageKey)
    setSession(null)
    setLoginState('idle')
    setMessage('Session expired')
  }

  useEffect(() => {
    if (!session) {
      return
    }

    async function loadGraph() {
      try {
        const response = await fetch(`${apiUrl}/graphs/${graphName}`, {
          headers: {
            Authorization: `Bearer ${session?.token}`,
          },
        })

        if (response.status === 401) {
          expireSession()
          return
        }

        if (!response.ok) {
          throw new Error('Unable to load graph')
        }

        const graph = (await response.json()) as GraphData
        setNodes(graph.nodes.map((node) => ({ ...node, document_section_id: node.document_section_id ?? null })))
        setEdges(graph.edges.map((edge) => ({ ...edge, label: edge.label || 'Relation' })))
        setGraphMessage('Graph loaded')
      } catch {
        setGraphMessage('Graph is unavailable')
      }
    }

    async function loadDocument() {
      try {
        const response = await fetch(`${apiUrl}/documents/${documentName}`, {
          headers: {
            Authorization: `Bearer ${session?.token}`,
          },
        })

        if (response.status === 401) {
          expireSession()
          return
        }

        if (!response.ok) {
          throw new Error('Unable to load document')
        }

        const document = (await response.json()) as DocumentData
        setSections(document.sections)
        setDocBlocksBySectionId(buildBlocksBySectionId(document.sections))
        setSelectedSectionId(document.sections[0]?.id ?? null)
        setDocMessage('Documentation loaded')
      } catch {
        setDocMessage('Documentation is unavailable')
      }
    }

    loadGraph()
    loadDocument()
  }, [session])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isSaveShortcut =
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === 's' ||
          event.key.toLowerCase() === 'ы' ||
          event.code === 'KeyS')

      if (!isSaveShortcut) {
        return
      }

      event.preventDefault()

      if (!session) {
        return
      }

      if (workspaceMode === 'docs') {
        saveDocument()
        return
      }

      saveGraph()
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [edges, nodes, sections, session, workspaceMode])

  useLayoutEffect(() => {
    document.querySelectorAll<HTMLTextAreaElement>('.auto-textarea').forEach(resizeTextarea)
  }, [selectedSectionId, selectedSectionBlocks])

  useLayoutEffect(() => {
    if (!focusBlockId) {
      return
    }

    const editor = document.querySelector<HTMLElement>(`[data-block-id="${focusBlockId}"]`)
    editor?.focus()
    setFocusBlockId(null)
  }, [focusBlockId, selectedSectionBlocks])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const login = String(formData.get('email') ?? '')
    const password = String(formData.get('password') ?? '')

    setLoginState('loading')
    setMessage('')

    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ login, password }),
      })

      if (!response.ok) {
        throw new Error('Invalid credentials')
      }

      const data = (await response.json()) as LoginResponse
      const nextSession = {
        username: login,
        token: data.token,
      }

      localStorage.setItem(sessionStorageKey, JSON.stringify(nextSession))
      setSession(nextSession)
      setLoginState('success')
      setMessage('Signed in')
    } catch {
      setLoginState('error')
      setMessage('Invalid email or password')
    }
  }

  function handleSignOut() {
    localStorage.removeItem(sessionStorageKey)
    setSession(null)
    setLoginState('idle')
    setSaveState('idle')
    setMessage('')
    setGraphMessage('')
    setDocMessage('')
    setSelectedNodeIds([])
    setSelectedEdgeId(null)
    setSelectedSectionId(null)
    setEditingSectionId(null)
    setDocBlocksBySectionId({})
  }

  function getCanvasPoint(event: MouseEvent<SVGSVGElement> | PointerEvent<SVGSVGElement>) {
    const svg = canvasRef.current

    if (!svg) {
      return { x: 0, y: 0 }
    }

    const rect = svg.getBoundingClientRect()
    return {
      x: Math.round((event.clientX - rect.left - pan.x) / zoom),
      y: Math.round((event.clientY - rect.top - pan.y) / zoom),
    }
  }

  function handleCanvasWheel(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault()

    const svg = canvasRef.current

    if (!svg) {
      return
    }

    const rect = svg.getBoundingClientRect()
    const cursorX = event.clientX - rect.left
    const cursorY = event.clientY - rect.top
    const graphX = (cursorX - pan.x) / zoom
    const graphY = (cursorY - pan.y) / zoom
    const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9
    const nextZoom = Math.max(0.25, Math.min(2.5, zoom * zoomFactor))

    setZoom(nextZoom)
    setPan({
      x: cursorX - graphX * nextZoom,
      y: cursorY - graphY * nextZoom,
    })
  }

  function addNode(x = 180, y = 130) {
    const nextNumber = nodes.length + 1
    const node: GraphNode = {
      id: crypto.randomUUID(),
      label: `Node ${nextNumber}`,
      x,
      y,
      document_section_id: null,
    }

    setNodes((currentNodes) => [...currentNodes, node])
    setSelectedNodeIds([node.id])
    setSelectedEdgeId(null)
    setGraphMessage('Node created')
  }

  function handleCanvasDoubleClick(event: MouseEvent<SVGSVGElement>) {
    if (event.target !== canvasRef.current) {
      return
    }

    const point = getCanvasPoint(event)
    addNode(point.x, point.y)
  }

  function handleCanvasPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || event.target !== canvasRef.current) {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setPanDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    })
  }

  function handleNodePointerDown(event: PointerEvent<SVGCircleElement>, nodeId: string) {
    const node = nodes.find((currentNode) => currentNode.id === nodeId)

    if ((event.ctrlKey || event.metaKey) && node?.document_section_id) {
      setSelectedSectionId(node.document_section_id)
      setWorkspaceMode('docs')
      setGraphMessage('Linked chapter opened')
      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    setDraggingNodeId(nodeId)
    setSelectedNodeIds((currentIds) => {
      if (!event.shiftKey) {
        return [nodeId]
      }

      if (currentIds.includes(nodeId)) {
        return currentIds
      }

      return [...currentIds, nodeId].slice(-2)
    })
    setSelectedEdgeId(null)
  }

  function handleCanvasPointerMove(event: PointerEvent<SVGSVGElement>) {
    if (panDrag) {
      setPan({
        x: panDrag.originX + event.clientX - panDrag.startX,
        y: panDrag.originY + event.clientY - panDrag.startY,
      })
      return
    }

    if (!draggingNodeId) {
      return
    }

    const point = getCanvasPoint(event)
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === draggingNodeId ? { ...node, x: point.x, y: point.y } : node,
      ),
    )
  }

  function handleCanvasPointerUp(event: PointerEvent<SVGSVGElement>) {
    if (panDrag?.pointerId === event.pointerId) {
      setPanDrag(null)
    }

    setDraggingNodeId(null)
  }

  function connectSelectedNodes() {
    if (selectedNodeIds.length !== 2) {
      setGraphMessage('Select two nodes')
      return
    }

    const [source, target] = selectedNodeIds
    const edgeExists = edges.some(
      (edge) =>
        (edge.source === source && edge.target === target) ||
        (edge.source === target && edge.target === source),
    )

    if (edgeExists) {
      setGraphMessage('Nodes already connected')
      return
    }

    setEdges((currentEdges) => [
      ...currentEdges,
      {
        id: crypto.randomUUID(),
        source,
        target,
        label: 'Relation',
      },
    ])
    setGraphMessage('Nodes connected')
  }

  function updateSelectedNodeLabel(label: string) {
    if (!selectedNode) {
      return
    }

    setNodes((currentNodes) =>
      currentNodes.map((node) => (node.id === selectedNode.id ? { ...node, label } : node)),
    )
  }

  function updateSelectedNodeDocument(sectionId: string) {
    if (!selectedNode) {
      return
    }

    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === selectedNode.id
          ? { ...node, document_section_id: sectionId || null }
          : node,
      ),
    )
  }

  function updateSelectedEdgeLabel(label: string) {
    if (!selectedEdgeId) {
      return
    }

    setEdges((currentEdges) =>
      currentEdges.map((edge) => (edge.id === selectedEdgeId ? { ...edge, label } : edge)),
    )
  }

  function selectEdge(edgeId: string) {
    setSelectedEdgeId(edgeId)
    setSelectedNodeIds([])
  }

  function addSection(parentId?: string) {
    const nextNumber = countSections(sections) + 1
    const section: DocSection = {
      id: crypto.randomUUID(),
      title: parentId ? `Subchapter ${nextNumber}` : `Chapter ${nextNumber}`,
      content: '',
      children: [],
    }

    if (!parentId) {
      setSections((currentSections) => [...currentSections, section])
    } else {
      setSections((currentSections) =>
        updateSectionTree(currentSections, parentId, (currentSection) => ({
          ...currentSection,
          children: [...currentSection.children, section],
        })),
      )
    }

    setSelectedSectionId(section.id)
    setDocBlocksBySectionId((currentBlocks) => ({
      ...currentBlocks,
      [section.id]: [],
    }))
    setDocMessage(parentId ? 'Subchapter created' : 'Chapter created')
  }

  function updateSectionTitle(sectionId: string, title: string) {
    setSections((currentSections) =>
      updateSectionTree(currentSections, sectionId, (section) => ({ ...section, title })),
    )
  }

  function deleteSection(sectionId: string) {
    const sectionToDelete = findSection(sections, sectionId)

    if (!sectionToDelete || !window.confirm(`Delete "${sectionToDelete.title || 'Untitled'}" and all nested subchapters?`)) {
      return
    }

    let nextSelectedSectionId: string | null = null

    setSections((currentSections) => {
      const { nextSections, removedSection } = removeSectionFromTree(currentSections, sectionId)

      if (!removedSection) {
        nextSelectedSectionId = selectedSectionId
        return currentSections
      }

      const removedIds = new Set(collectSectionIds(removedSection))

      if (selectedSectionId && !removedIds.has(selectedSectionId)) {
        nextSelectedSectionId = selectedSectionId
      } else {
        nextSelectedSectionId = flattenSections(nextSections)[0]?.id ?? null
      }

      setDocBlocksBySectionId((currentBlocks) => {
        const nextBlocks = { ...currentBlocks }

        for (const removedId of removedIds) {
          delete nextBlocks[removedId]
        }

        return nextBlocks
      })

      return nextSections
    })

    setSelectedSectionId(nextSelectedSectionId)
    setEditingSectionId(null)
    setDocMessage('Chapter deleted')
  }

  function updateSelectedSectionContent(content: string) {
    if (!selectedSectionId) {
      return
    }

    setSections((currentSections) =>
      updateSectionTree(currentSections, selectedSectionId, (section) => ({ ...section, content })),
    )
  }

  function updateSelectedSectionBlocks(blocks: DocBlock[]) {
    if (!selectedSectionId) {
      return
    }

    setDocBlocksBySectionId((currentBlocks) => ({
      ...currentBlocks,
      [selectedSectionId]: blocks,
    }))
    updateSelectedSectionContent(serializeMarkdownBlocks(blocks))
  }

  function createContentBlock(type: DocBlockType, value?: string): DocBlock {
    const initialValueByType: Record<DocBlockType, string> = {
      text: '',
      heading: '',
      image: '',
      code: '',
      playground: "print('Hello from playground')",
      terminal: stringifyTerminalBlockConfig(createDefaultTerminalConfig()),
      quote: '',
    }

    return {
      id: createId(),
      type,
      value: value ?? initialValueByType[type],
      font: type === 'text' ? 'default' : undefined,
    }
  }

  function requestImageForBlock(blockId: string) {
    setPendingImageBlockId(blockId)
    setPendingImageInsertIndex(null)
    imageInputRef.current?.click()
  }

  async function handleNewImageFile(file: File) {
    if (!selectedSectionId) {
      return
    }

    const blockId = pendingImageBlockId ?? createId()
    let nextBlocks: DocBlock[]

    if (pendingImageBlockId) {
      nextBlocks = selectedSectionBlocks.map((block): DocBlock =>
        block.id === pendingImageBlockId
          ? { ...block, type: 'image', value: '', font: undefined }
          : block,
      )
    } else {
      const insertIndex = pendingImageInsertIndex ?? selectedSectionBlocks.length
      nextBlocks = [...selectedSectionBlocks]
      nextBlocks.splice(insertIndex, 0, createContentBlock('image'))
      nextBlocks[insertIndex] = { ...nextBlocks[insertIndex], id: blockId }
    }

    updateSelectedSectionBlocks(nextBlocks)
    setPendingImageInsertIndex(null)
    setPendingImageBlockId(null)
    await uploadImageBlock(blockId, file, nextBlocks)
  }

  function transformContentBlock(blockId: string, type: DocBlockType) {
    const currentBlock = selectedSectionBlocks.find((block) => block.id === blockId)
    const cleanedValue = currentBlock?.value.trim() === '/' ? '' : currentBlock?.value.replace(/\/$/, '') ?? ''

    setSlashMenuBlockId(null)
    setSlashMenuIndex(0)

    if (type === 'image') {
      const imageBlocks = selectedSectionBlocks.map((block): DocBlock =>
        block.id === blockId
          ? { ...block, type: 'image', value: '', font: undefined }
          : block,
      )
      const { blocks: nextBlocks, insertedBlockId } = ensureTextBlockAfter(imageBlocks, blockId)
      updateSelectedSectionBlocks(nextBlocks)
      if (insertedBlockId) {
        setFocusBlockId(insertedBlockId)
      }
      requestImageForBlock(blockId)
      return
    }

    const transformedBlocks = selectedSectionBlocks.map((block) =>
        block.id === blockId
          ? {
              ...block,
              type,
              value: cleanedValue,
              font: type === 'text' ? (block.font ?? 'default') : undefined,
            }
          : block,
      )

    if (type === 'text') {
      updateSelectedSectionBlocks(transformedBlocks)
      setFocusBlockId(blockId)
      return
    }

    const { blocks: nextBlocks } = ensureTextBlockAfter(transformedBlocks, blockId)
    updateSelectedSectionBlocks(nextBlocks)
    setFocusBlockId(blockId)
  }

  function handleEditableBlockChange(
    event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>,
    block: DocBlock,
  ) {
    const value = event.target.value
    const shouldOpenSlashMenu = block.type === 'text' && value.endsWith('/')

    if ('currentTarget' in event && event.currentTarget instanceof HTMLTextAreaElement) {
      resizeTextarea(event.currentTarget)
    }

    setSlashMenuBlockId(shouldOpenSlashMenu ? block.id : null)
    setSlashMenuIndex(0)
    updateContentBlock(block.id, value)
  }

  function appendTrailingTextBlock() {
    const block = createContentBlock('text')
    const nextBlocks =
      selectedSectionBlocks.length > 0 ? [...selectedSectionBlocks, block] : [block]

    updateSelectedSectionBlocks(nextBlocks)
    setSlashMenuBlockId(null)
    setSlashMenuIndex(0)
    setFocusBlockId(block.id)
  }

  function focusNearestEditableBlock(blocks: DocBlock[], startIndex: number) {
    for (let index = startIndex; index >= 0; index -= 1) {
      if (blocks[index].type !== 'image') {
        setFocusBlockId(blocks[index].id)
        return
      }
    }

    for (let index = startIndex + 1; index < blocks.length; index += 1) {
      if (blocks[index].type !== 'image') {
        setFocusBlockId(blocks[index].id)
        return
      }
    }
  }

  function focusAdjacentEditableBlock(blockId: string, direction: -1 | 1) {
    const blockIndex = selectedSectionBlocks.findIndex((block) => block.id === blockId)

    if (blockIndex < 0) {
      return false
    }

    for (
      let index = blockIndex + direction;
      index >= 0 && index < selectedSectionBlocks.length;
      index += direction
    ) {
      if (selectedSectionBlocks[index].type !== 'image') {
        setFocusBlockId(selectedSectionBlocks[index].id)
        return true
      }
    }

    if (direction > 0 && shouldRenderTrailingPlaceholder) {
      appendTrailingTextBlock()
      return true
    }

    return false
  }

  function ensureTextBlockAfter(
    blocks: DocBlock[],
    blockId: string,
  ): { blocks: DocBlock[]; insertedBlockId: string | null } {
    const blockIndex = blocks.findIndex((block) => block.id === blockId)

    if (blockIndex < 0) {
      return { blocks, insertedBlockId: null }
    }

    const nextBlock = blocks[blockIndex + 1]

    if (nextBlock?.type === 'text' && !nextBlock.value.trim()) {
      return { blocks, insertedBlockId: nextBlock.id }
    }

    const newTextBlock = createContentBlock('text')
    const nextBlocks = [...blocks]
    nextBlocks.splice(blockIndex + 1, 0, newTextBlock)
    return { blocks: nextBlocks, insertedBlockId: newTextBlock.id }
  }

  function insertTextBlockAfter(blockId: string) {
    const blockIndex = selectedSectionBlocks.findIndex((block) => block.id === blockId)

    if (blockIndex < 0) {
      return
    }

    const nextBlock = createContentBlock('text')
    const nextBlocks = [...selectedSectionBlocks]
    nextBlocks.splice(blockIndex + 1, 0, nextBlock)
    updateSelectedSectionBlocks(nextBlocks)
    setSlashMenuBlockId(null)
    setSlashMenuIndex(0)
    setFocusBlockId(nextBlock.id)
  }

  function handleBlockBackspace(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    block: DocBlock,
  ) {
    if (event.key !== 'Backspace') {
      return
    }

    const target = event.currentTarget
    const isEmptyAtStart =
      target.value.length === 0 && target.selectionStart === 0 && target.selectionEnd === 0

    if (!isEmptyAtStart || selectedSectionBlocks.length <= 1) {
      return
    }

    const blockIndex = selectedSectionBlocks.findIndex((currentBlock) => currentBlock.id === block.id)

    if (blockIndex <= 0) {
      return
    }

    event.preventDefault()

    const nextBlocks = selectedSectionBlocks.filter((currentBlock) => currentBlock.id !== block.id)
    updateSelectedSectionBlocks(nextBlocks)
    focusNearestEditableBlock(nextBlocks, blockIndex - 1)
    setSlashMenuBlockId(null)
    setSlashMenuIndex(0)
  }

  function handleBlockArrowNavigation(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    block: DocBlock,
  ) {
    const target = event.currentTarget
    const selectionStart = target.selectionStart ?? 0
    const selectionEnd = target.selectionEnd ?? 0
    const valueLength = target.value.length

    if (event.key === 'ArrowUp' && selectionStart === 0 && selectionEnd === 0) {
      if (focusAdjacentEditableBlock(block.id, -1)) {
        event.preventDefault()
      }
      return
    }

    if (event.key === 'ArrowDown' && selectionStart === valueLength && selectionEnd === valueLength) {
      if (focusAdjacentEditableBlock(block.id, 1)) {
        event.preventDefault()
      }
    }
  }

  function moveSlashMenuSelection(direction: 1 | -1) {
    setSlashMenuIndex((currentIndex) => {
      const nextIndex = currentIndex + direction

      if (nextIndex < 0) {
        return slashCommands.length - 1
      }

      if (nextIndex >= slashCommands.length) {
        return 0
      }

      return nextIndex
    })
  }

  function handleSlashMenuKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    blockId: string,
  ) {
    if (slashMenuBlockId !== blockId) {
      return false
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSlashMenuSelection(1)
      return true
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSlashMenuSelection(-1)
      return true
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      transformContentBlock(blockId, slashCommands[slashMenuIndex].type)
      return true
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setSlashMenuBlockId(null)
      setSlashMenuIndex(0)
      return true
    }

    return false
  }

  function handleBlockEnter(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    blockId: string,
  ) {
    if (event.key !== 'Enter' || event.shiftKey) {
      return
    }

    event.preventDefault()
    insertTextBlockAfter(blockId)
  }

  function renderSlashMenu(blockId: string) {
    if (slashMenuBlockId !== blockId) {
      return null
    }

    return (
      <div className="slash-menu" onMouseDown={(event) => event.preventDefault()}>
        {slashCommands.map((command, index) => (
          <button
            className={`slash-command${index === slashMenuIndex ? ' active' : ''}`}
            key={command.type}
            type="button"
            onMouseEnter={() => setSlashMenuIndex(index)}
            onClick={() => transformContentBlock(blockId, command.type)}
          >
            <span className="slash-command-label">{command.label}</span>
            <span className="slash-command-hint">{command.hint}</span>
          </button>
        ))}
      </div>
    )
  }

  function renderTrailingPlaceholder() {
    if (!shouldRenderTrailingPlaceholder) {
      return null
    }

    return (
      <div className="content-block text-block trailing-placeholder-block">
        <button
          className="trailing-placeholder-button"
          type="button"
          onClick={appendTrailingTextBlock}
        >
          Type / for commands
        </button>
      </div>
    )
  }

  function updateContentBlock(blockId: string, value: string) {
    if (!selectedSectionId) {
      return
    }

    setDocBlocksBySectionId((currentBlocks) => {
      const currentSectionBlocks = currentBlocks[selectedSectionId] ?? []
      const nextBlocks = currentSectionBlocks.map((block) =>
        block.id === blockId ? { ...block, value } : block,
      )

      setSections((currentSections) =>
        updateSectionTree(currentSections, selectedSectionId, (section) => ({
          ...section,
          content: serializeMarkdownBlocks(nextBlocks),
        })),
      )

      return {
        ...currentBlocks,
        [selectedSectionId]: nextBlocks,
      }
    })
  }

  function removeContentBlock(blockId: string) {
    updateSelectedSectionBlocks(selectedSectionBlocks.filter((block) => block.id !== blockId))
    setPlaygroundOutputByBlockId((current) => {
      const next = { ...current }
      delete next[blockId]
      return next
    })
    setPlaygroundRunStateByBlockId((current) => {
      const next = { ...current }
      delete next[blockId]
      return next
    })
  }

  function duplicateContentBlock(blockId: string) {
    const blockIndex = selectedSectionBlocks.findIndex((block) => block.id === blockId)

    if (blockIndex < 0) {
      return
    }

    const sourceBlock = selectedSectionBlocks[blockIndex]
    const duplicatedBlock: DocBlock = {
      ...sourceBlock,
      id: createId(),
    }
    const nextBlocks = [...selectedSectionBlocks]
    nextBlocks.splice(blockIndex + 1, 0, duplicatedBlock)
    updateSelectedSectionBlocks(nextBlocks)
    setFocusBlockId(duplicatedBlock.id)
    setDocMessage('Block duplicated')
  }

  function moveContentBlock(blockId: string, direction: -1 | 1) {
    const blockIndex = selectedSectionBlocks.findIndex((block) => block.id === blockId)
    const nextIndex = blockIndex + direction

    if (blockIndex < 0 || nextIndex < 0 || nextIndex >= selectedSectionBlocks.length) {
      return
    }

    const nextBlocks = [...selectedSectionBlocks]
    const [movedBlock] = nextBlocks.splice(blockIndex, 1)
    nextBlocks.splice(nextIndex, 0, movedBlock)
    updateSelectedSectionBlocks(nextBlocks)
    setFocusBlockId(blockId)
  }

  async function runPlaygroundBlock(block: DocBlock) {
    if (!session || block.type !== 'playground') {
      return
    }

    setPlaygroundRunStateByBlockId((current) => ({
      ...current,
      [block.id]: 'running',
    }))

    try {
      const response = await fetch(`${apiUrl}/playground/run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: block.value }),
      })

      if (response.status === 401) {
        expireSession()
        return
      }

      if (!response.ok) {
        throw new Error('Unable to run playground code')
      }

      const result = (await response.json()) as PlaygroundRunResponse
      setPlaygroundOutputByBlockId((current) => ({
        ...current,
        [block.id]: result,
      }))
    } catch {
      setPlaygroundOutputByBlockId((current) => ({
        ...current,
        [block.id]: {
          success: false,
          exit_code: 1,
          stdout: '',
          stderr: 'Unable to run playground code',
        },
      }))
    } finally {
      setPlaygroundRunStateByBlockId((current) => ({
        ...current,
        [block.id]: 'idle',
      }))
    }
  }

  async function saveDocument(sectionsToSave = sections) {
    if (!session) {
      return false
    }

    setDocSaveState('loading')
    setDocMessage('')

    try {
      const response = await fetch(`${apiUrl}/documents/${documentName}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sections: sectionsToSave }),
      })

      if (!response.ok) {
        throw new Error('Unable to save documentation')
      }

      setDocSaveState('success')
      setDocMessage('Documentation saved')
      return true
    } catch {
      setDocSaveState('error')
      setDocMessage('Save failed')
      return false
    }
  }

  async function uploadImageBlock(blockId: string, file: File, blocksOverride?: DocBlock[]) {
    if (!session || !selectedSectionId) {
      return
    }

    setDocMessage('Saving before upload...')
    const blocksToSave = blocksOverride ?? selectedSectionBlocks
    const sectionsToSave = sections.map((section) =>
      selectedSectionId
        ? updateSectionTree([section], selectedSectionId, (currentSection) => ({
            ...currentSection,
            content: serializeMarkdownBlocks(blocksToSave),
          }))[0]
        : section,
    )

    const saved = await saveDocument(sectionsToSave)

    if (!saved) {
      return
    }

    const formData = new FormData()
    formData.append('file', file)

    try {
      const response = await fetch(
        `${apiUrl}/documents/${documentName}/sections/${selectedSectionId}/assets`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.token}`,
          },
          body: formData,
        },
      )

      if (!response.ok) {
        throw new Error('Unable to upload image')
      }

      const upload = (await response.json()) as AssetUploadResponse
      updateContentBlock(blockId, upload.relative_path)
      setDocMessage('Image uploaded')
    } catch {
      setDocSaveState('error')
      setDocMessage('Image upload failed')
    }
  }

  async function saveGraph() {
    if (!session) {
      return
    }

    setSaveState('loading')
    setGraphMessage('')

    try {
      const response = await fetch(`${apiUrl}/graphs/${graphName}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodes, edges }),
      })

      if (!response.ok) {
        throw new Error('Unable to save graph')
      }

      setSaveState('success')
      setGraphMessage('Graph saved')
    } catch {
      setSaveState('error')
      setGraphMessage('Save failed')
    }
  }

  function clearGraph() {
    setNodes([])
    setEdges([])
    setSelectedNodeIds([])
    setSelectedEdgeId(null)
    setGraphMessage('Graph cleared')
  }

  function renderSectionTree(sectionList: DocSection[], level = 0) {
    return sectionList.map((section) => (
      <div key={section.id} className="doc-tree-item">
        <div
          className={selectedSectionId === section.id ? 'doc-tree-row selected' : 'doc-tree-row'}
          style={{ '--section-depth': level } as CSSProperties}
          onClick={() => setSelectedSectionId(section.id)}
        >
          {editingSectionId === section.id ? (
            <input
              className="doc-tree-input"
              value={section.title}
              aria-label="Chapter title"
              autoFocus
              placeholder="Untitled"
              onBlur={() => setEditingSectionId(null)}
              onChange={(event) => updateSectionTitle(section.id, event.target.value)}
              onFocus={() => setSelectedSectionId(section.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'Escape') {
                  setEditingSectionId(null)
                }
              }}
            />
          ) : (
            <>
              <span className="doc-tree-title">{section.title || 'Untitled'}</span>
              <button
                className="doc-title-add-button"
                type="button"
                aria-label="Add subchapter"
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedSectionId(section.id)
                  addSection(section.id)
                }}
              >
                +
              </button>
              <button
                className="doc-title-edit-button"
                type="button"
                aria-label="Edit chapter title"
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedSectionId(section.id)
                  setEditingSectionId(section.id)
                }}
              >
                ✎
              </button>
              <button
                className="doc-title-delete-button"
                type="button"
                aria-label="Delete chapter"
                onClick={(event) => {
                  event.stopPropagation()
                  deleteSection(section.id)
                }}
              >
                🗑
              </button>
            </>
          )}
        </div>
        {section.children.length > 0 && renderSectionTree(section.children, level + 1)}
      </div>
    ))
  }

  if (session) {
    return (
      <main className="workspace-shell">
        <section className="workspace-panel" aria-labelledby="dashboard-title">
          <header className="workspace-header">
            <div>
              <div className="dashboard-header">
                <span className="status-dot" aria-hidden="true" />
                <h1 id="dashboard-title">Workspace</h1>
              </div>
              <p className="profile-label">Signed in as {session.username}</p>
            </div>
            <button className="secondary-button small-button" type="button" onClick={handleSignOut}>
              Sign out
            </button>
          </header>

          <div className="mode-tabs" aria-label="Workspace mode">
            <button
              className={workspaceMode === 'graph' ? 'active' : ''}
              type="button"
              onClick={() => setWorkspaceMode('graph')}
            >
              Graph
            </button>
            <button
              className={workspaceMode === 'docs' ? 'active' : ''}
              type="button"
              onClick={() => setWorkspaceMode('docs')}
            >
              Documentation
            </button>
          </div>

          {workspaceMode === 'graph' && (
            <>
              <div className="toolbar">
                <button type="button" onClick={() => addNode()}>
                  Add node
                </button>
                <button className="secondary-button" type="button" onClick={connectSelectedNodes}>
                  Connect
                </button>
                <button className="secondary-button" type="button" onClick={saveGraph}>
                  {saveState === 'loading' ? 'Saving...' : 'Save'}
                </button>
                <button className="secondary-button" type="button" onClick={clearGraph}>
                  Clear
                </button>
              </div>

              <div className="graph-layout">
                <svg
                ref={canvasRef}
                className={panDrag ? 'graph-canvas panning' : 'graph-canvas'}
                role="img"
                aria-label="Graph editor"
                onDoubleClick={handleCanvasDoubleClick}
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onWheel={handleCanvasWheel}
                onPointerLeave={() => {
                  setDraggingNodeId(null)
                  setPanDrag(null)
                }}
              >
                <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
                    {edges.map((edge) => {
                      const source = nodes.find((node) => node.id === edge.source)
                      const target = nodes.find((node) => node.id === edge.target)

                      if (!source || !target) {
                        return null
                      }

                      const midX = (source.x + target.x) / 2
                      const midY = (source.y + target.y) / 2
                      const isSelected = selectedEdgeId === edge.id

                      return (
                        <g
                          key={edge.id}
                          className={isSelected ? 'graph-edge-group selected' : 'graph-edge-group'}
                          onClick={() => selectEdge(edge.id)}
                        >
                          <line
                            className="graph-edge-hit"
                            x1={source.x}
                            y1={source.y}
                            x2={target.x}
                            y2={target.y}
                          />
                          <line
                            className="graph-edge"
                            x1={source.x}
                            y1={source.y}
                            x2={target.x}
                            y2={target.y}
                          />
                          <text className="edge-label" x={midX} y={midY - 8}>
                            {edge.label}
                          </text>
                        </g>
                      )
                    })}

                    {nodes.map((node) => {
                      const isSelected = selectedNodeIds.includes(node.id)
                      const nodeRadius = getNodeRadius(node.label)

                      return (
                        <g key={node.id} className={isSelected ? 'graph-node selected' : 'graph-node'}>
                          <circle
                            cx={node.x}
                            cy={node.y}
                            r={nodeRadius}
                            onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                          />
                          <text x={node.x} y={node.y + 5}>
                            {node.label}
                          </text>
                          {node.document_section_id && (
                            <text className="node-doc-badge" x={node.x} y={node.y + nodeRadius + 18}>
                              doc
                            </text>
                          )}
                        </g>
                      )
                    })}
                </g>
              </svg>

                {(selectedNode || selectedEdge) && (
                  <aside className="properties-panel" aria-label="Graph properties">
                    <h2>Properties</h2>

                    {selectedNode && (
                      <>
                        <label htmlFor="node-label">
                          Node name
                          <input
                            id="node-label"
                            type="text"
                            value={selectedNode.label}
                            onChange={(event) => updateSelectedNodeLabel(event.target.value)}
                          />
                        </label>
                        <label htmlFor="node-document">
                          Linked chapter
                          <select
                            id="node-document"
                            value={selectedNode.document_section_id ?? ''}
                            onChange={(event) => updateSelectedNodeDocument(event.target.value)}
                          >
                            <option value="">No linked chapter</option>
                            {sectionOptions.map((section) => (
                              <option key={section.id} value={section.id}>
                                {'--'.repeat(section.depth)} {section.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        {linkedSection && (
                          <button
                            className="secondary-button small-button"
                            type="button"
                            onClick={() => {
                              setSelectedSectionId(linkedSection.id)
                              setWorkspaceMode('docs')
                            }}
                          >
                            Open chapter
                          </button>
                        )}
                      </>
                    )}

                    {selectedEdge && (
                      <label htmlFor="edge-label">
                        Relation label
                        <input
                          id="edge-label"
                          type="text"
                          value={selectedEdge.label}
                          onChange={(event) => updateSelectedEdgeLabel(event.target.value)}
                        />
                      </label>
                    )}
                  </aside>
                )}
              </div>

              <footer className="graph-footer">
                <span>{nodes.length} nodes</span>
                <span>{edges.length} edges</span>
                <span>{selectedNodes.length + (selectedEdge ? 1 : 0)} selected</span>
                <span className={saveState === 'error' ? 'danger-text' : 'success-text'}>
                  {graphMessage}
                </span>
              </footer>
            </>
          )}

          {workspaceMode === 'docs' && (
            <>
              <div className="toolbar">
                <button className="secondary-button" type="button" onClick={() => saveDocument()}>
                  {docSaveState === 'loading' ? 'Saving...' : 'Save'}
                </button>
              </div>

              <div className="docs-layout">
                <aside className="docs-sidebar" aria-label="Documentation chapters">
                  <div className="docs-sidebar-header">
                    <div className="docs-sidebar-title-row">
                      <h2>Chapters</h2>
                      <button
                        className="doc-title-add-button root"
                        type="button"
                        aria-label="Add chapter"
                        onClick={() => addSection()}
                      >
                        +
                      </button>
                    </div>
                    <input
                      className="section-search-input"
                      type="search"
                      value={sectionSearch}
                      placeholder="Search chapters"
                      onChange={(event) => setSectionSearch(event.target.value)}
                    />
                    {sectionSearch.trim() ? (
                      <p className="section-search-status">
                        {filteredSectionCount > 0
                          ? `${filteredSectionCount} result${filteredSectionCount === 1 ? '' : 's'}`
                          : 'No matches'}
                      </p>
                    ) : null}
                  </div>
                  <nav className="doc-tree">
                    {sections.length > 0 ? (
                      filteredSections.length > 0 ? (
                        renderSectionTree(filteredSections)
                      ) : (
                        <p>No chapters found</p>
                      )
                    ) : (
                      <p>No chapters yet</p>
                    )}
                  </nav>
                </aside>

                <section className="doc-editor" aria-label="Documentation editor">
                  {selectedSection ? (
                    <>
                      <div className="doc-editor-header">
                        <div>
                          <p className="profile-label">Editing</p>
                          <h2>{selectedSection.title || 'Untitled'}</h2>
                        </div>
                        <input
                          ref={imageInputRef}
                          type="file"
                          accept="image/*"
                          hidden
                          onChange={(event) => {
                            const file = event.target.files?.[0]

                            if (file) {
                              handleNewImageFile(file)
                            }

                            event.target.value = ''
                          }}
                        />
                      </div>

                      <div className="content-blocks">
                        {selectedSectionBlocks.length > 0 ? (
                          <>
                            {selectedSectionBlocks.map((block) => (
                              <div className="block-with-divider" key={block.id}>
                                <div className={`content-block ${block.type}-block`}>
                                  <div className="block-actions">
                                    <button
                                      className="block-action-button"
                                      type="button"
                                      aria-label="Move block up"
                                      disabled={selectedSectionBlocks[0]?.id === block.id}
                                      onClick={() => moveContentBlock(block.id, -1)}
                                    >
                                      ↑
                                    </button>
                                    <button
                                      className="block-action-button"
                                      type="button"
                                      aria-label="Move block down"
                                      disabled={selectedSectionBlocks[selectedSectionBlocks.length - 1]?.id === block.id}
                                      onClick={() => moveContentBlock(block.id, 1)}
                                    >
                                      ↓
                                    </button>
                                    <button
                                      className="block-action-button"
                                      type="button"
                                      aria-label="Duplicate block"
                                      onClick={() => duplicateContentBlock(block.id)}
                                    >
                                      ⧉
                                    </button>
                                    <button
                                      className="block-remove-button"
                                      type="button"
                                      aria-label="Remove block"
                                      onClick={() => removeContentBlock(block.id)}
                                    >
                                      ×
                                    </button>
                                  </div>

                                  {block.type === 'heading' && (
                                    <input
                                      className="heading-input"
                                      data-block-id={block.id}
                                      type="text"
                                      value={block.value}
                                      placeholder="Heading 1"
                                      onKeyDown={(event) => {
                                        handleBlockArrowNavigation(event, block)
                                        handleBlockBackspace(event, block)
                                        handleBlockEnter(event, block.id)
                                      }}
                                      onChange={(event) => handleEditableBlockChange(event, block)}
                                    />
                                  )}

                                  {block.type === 'image' && (
                                    <div className="image-block-editor">
                                      {block.value && (
                                        <img
                                          className="image-preview"
                                          src={getImagePreviewUrl(documentName, selectedSectionId, block.value)}
                                          alt=""
                                        />
                                      )}
                                    </div>
                                  )}

                                  {block.type === 'code' && (
                                    <div className="code-editor">
                                      <button
                                        className="code-copy-button"
                                        type="button"
                                        onClick={() => {
                                          navigator.clipboard.writeText(block.value)
                                          setDocMessage('Code copied')
                                        }}
                                      >
                                        Copy
                                      </button>
                                      <pre className="code-highlight" aria-hidden="true">
                                        <code>{highlightCode(block.value)}</code>
                                      </pre>
                                      <textarea
                                        data-block-id={block.id}
                                        className="code-input auto-textarea"
                                        value={block.value}
                                        placeholder="Code"
                                        spellCheck={false}
                                        onKeyDown={(event) => {
                                          handleBlockArrowNavigation(event, block)
                                          handleBlockBackspace(event, block)
                                        }}
                                        onChange={(event) => {
                                          resizeTextarea(event.currentTarget)
                                          updateContentBlock(block.id, event.target.value)
                                        }}
                                      />
                                    </div>
                                  )}

                                  {block.type === 'playground' && (
                                    <div className="playground-editor">
                                      <div className="playground-toolbar">
                                        <span className="playground-badge">Python</span>
                                        <button
                                          className="playground-run-button"
                                          type="button"
                                          onClick={() => runPlaygroundBlock(block)}
                                        >
                                          {playgroundRunStateByBlockId[block.id] === 'running' ? 'Running...' : 'Run'}
                                        </button>
                                      </div>
                                      <div className="code-editor">
                                        <pre className="code-highlight" aria-hidden="true">
                                          <code>{highlightCode(block.value)}</code>
                                        </pre>
                                        <textarea
                                          data-block-id={block.id}
                                          className="code-input auto-textarea"
                                          value={block.value}
                                          placeholder="Python code"
                                          spellCheck={false}
                                          onKeyDown={(event) => {
                                            handleBlockBackspace(event, block)
                                          }}
                                          onChange={(event) => {
                                            resizeTextarea(event.currentTarget)
                                            updateContentBlock(block.id, event.target.value)
                                          }}
                                        />
                                      </div>
                                      {playgroundOutputByBlockId[block.id] && (
                                        <div
                                          className={
                                            playgroundOutputByBlockId[block.id].success
                                              ? 'playground-output success'
                                              : 'playground-output error'
                                          }
                                        >
                                          <div className="playground-output-header">
                                            Exit code: {playgroundOutputByBlockId[block.id].exit_code}
                                          </div>
                                          <pre>
                                            {playgroundOutputByBlockId[block.id].stdout ||
                                              playgroundOutputByBlockId[block.id].stderr ||
                                              'No output'}
                                            {playgroundOutputByBlockId[block.id].stdout &&
                                            playgroundOutputByBlockId[block.id].stderr
                                              ? `\n${playgroundOutputByBlockId[block.id].stderr}`
                                              : ''}
                                          </pre>
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {block.type === 'terminal' && (
                                    <TerminalBlock
                                      blockId={block.id}
                                      value={block.value}
                                      session={session}
                                      onChange={(nextValue) => updateContentBlock(block.id, nextValue)}
                                    />
                                  )}

                                  {block.type === 'text' && (
                                    <div className="markdown-block-editor">
                                      <textarea
                                        data-block-id={block.id}
                                        className="auto-textarea markdown-source"
                                        value={block.value}
                                        placeholder="Type / for commands"
                                        onBlur={() => {
                                          setSlashMenuBlockId(null)
                                          setSlashMenuIndex(0)
                                        }}
                                        onKeyDown={(event) => {
                                          if (handleSlashMenuKeyDown(event, block.id)) {
                                            return
                                          }

                                          handleBlockArrowNavigation(event, block)
                                          handleBlockBackspace(event, block)
                                          handleBlockEnter(event, block.id)
                                        }}
                                        onChange={(event) => {
                                          handleEditableBlockChange(event, block)
                                        }}
                                      />
                                      {renderSlashMenu(block.id)}
                                    </div>
                                  )}

                                  {block.type === 'quote' && (
                                    <textarea
                                      data-block-id={block.id}
                                      className="auto-textarea"
                                      value={block.value}
                                      placeholder="Quote"
                                      onKeyDown={(event) => {
                                        handleBlockArrowNavigation(event, block)
                                        handleBlockBackspace(event, block)
                                      }}
                                      onChange={(event) => {
                                        resizeTextarea(event.currentTarget)
                                        updateContentBlock(block.id, event.target.value)
                                      }}
                                    />
                                  )}
                                </div>
                              </div>
                            ))}
                            {renderTrailingPlaceholder()}
                          </>
                        ) : (
                          renderTrailingPlaceholder()
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="empty-doc-state">
                      <h2>Documentation</h2>
                      <p>Create a chapter to start writing.</p>
                    </div>
                  )}
                </section>
              </div>

              <footer className="graph-footer">
                <span>{countSections(sections)} sections</span>
                <span className={docSaveState === 'error' ? 'danger-text' : 'success-text'}>
                  {docMessage}
                </span>
              </footer>
            </>
          )}
        </section>
      </main>
    )
  }

  return (
    <main className="page-shell">
      <section className="auth-panel" aria-labelledby="login-title">
        <div className="auth-header">
          <h1 id="login-title">Sign in</h1>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label htmlFor="email">
            Email
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="name@example.com"
              required
            />
          </label>

          <label htmlFor="password">
            Password
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              required
            />
          </label>

          <div className="form-row">
            <label className="remember" htmlFor="remember">
              <input id="remember" name="remember" type="checkbox" />
              Remember me
            </label>
          </div>

          {message && (
            <p className={`status-message ${loginState}`} role="status">
              {message}
            </p>
          )}

          <button type="submit" disabled={loginState === 'loading'}>
            {loginState === 'loading' ? 'Signing in...' : 'Continue'}
          </button>
        </form>
      </section>
    </main>
  )
}

export default App
