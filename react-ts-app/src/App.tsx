import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  ChangeEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent,
  WheelEvent,
} from 'react'
import './App.css'

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

type DocBlockType = 'text' | 'heading' | 'image' | 'code' | 'quote'
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

function getNodeRadius(label: string): number {
  return Math.max(30, Math.min(82, label.length * 4.2 + 16))
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
  const [docBlocksBySectionId, setDocBlocksBySectionId] = useState<Record<string, DocBlock[]>>({})
  const [pendingImageInsertIndex, setPendingImageInsertIndex] = useState<number | null>(null)
  const [pendingImageBlockId, setPendingImageBlockId] = useState<string | null>(null)
  const [slashMenuBlockId, setSlashMenuBlockId] = useState<string | null>(null)
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null)

  const selectedNodes = useMemo(
    () => nodes.filter((node) => selectedNodeIds.includes(node.id)),
    [nodes, selectedNodeIds],
  )
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null
  const selectedSection = findSection(sections, selectedSectionId)
  const sectionOptions = useMemo(() => flattenSections(sections), [sections])
  const selectedSectionBlocks = selectedSectionId ? docBlocksBySectionId[selectedSectionId] ?? [] : []
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
      nextBlocks = selectedSectionBlocks.map((block) =>
        block.id === pendingImageBlockId ? { ...block, type: 'image', value: '', font: undefined } : block,
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

    if (type === 'image') {
      updateSelectedSectionBlocks(
        selectedSectionBlocks.map((block) =>
          block.id === blockId ? { ...block, type: 'image', value: '', font: undefined } : block,
        ),
      )
      requestImageForBlock(blockId)
      return
    }

    updateSelectedSectionBlocks(
      selectedSectionBlocks.map((block) =>
        block.id === blockId
          ? {
              ...block,
              type,
              value: cleanedValue,
              font: type === 'text' ? (block.font ?? 'default') : undefined,
            }
          : block,
      ),
    )
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
    updateContentBlock(block.id, value)
  }

  function handleEmptyEditorChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value
    const block = createContentBlock('text', value)

    resizeTextarea(event.currentTarget)
    updateSelectedSectionBlocks([block])
    setSlashMenuBlockId(value.endsWith('/') ? block.id : null)
    setFocusBlockId(block.id)
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
    setFocusBlockId(nextBlock.id)
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
        {slashCommands.map((command) => (
          <button
            className="slash-command"
            key={command.type}
            type="button"
            onClick={() => transformContentBlock(blockId, command.type)}
          >
            <span className="slash-command-label">{command.label}</span>
            <span className="slash-command-hint">{command.hint}</span>
          </button>
        ))}
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
                <button type="button" onClick={() => addSection()}>
                  Add chapter
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!selectedSection}
                  onClick={() => selectedSection && addSection(selectedSection.id)}
                >
                  Add subchapter
                </button>
                <button className="secondary-button" type="button" onClick={() => saveDocument()}>
                  {docSaveState === 'loading' ? 'Saving...' : 'Save'}
                </button>
              </div>

              <div className="docs-layout">
                <aside className="docs-sidebar" aria-label="Documentation chapters">
                  <h2>Chapters</h2>
                  <nav className="doc-tree">
                    {sections.length > 0 ? renderSectionTree(sections) : <p>No chapters yet</p>}
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
                                  <button
                                    className="block-remove-button"
                                    type="button"
                                    aria-label="Remove block"
                                    onClick={() => removeContentBlock(block.id)}
                                  >
                                    ×
                                  </button>

                                  {block.type === 'heading' && (
                                    <input
                                      className="heading-input"
                                      data-block-id={block.id}
                                      type="text"
                                      value={block.value}
                                      placeholder="Heading 1"
                                      onKeyDown={(event) => handleBlockEnter(event, block.id)}
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
                                        className="code-input auto-textarea"
                                        value={block.value}
                                        placeholder="Code"
                                        spellCheck={false}
                                        onChange={(event) => {
                                          resizeTextarea(event.currentTarget)
                                          updateContentBlock(block.id, event.target.value)
                                        }}
                                      />
                                    </div>
                                  )}

                                  {block.type === 'text' && (
                                    <div className="markdown-block-editor">
                                      <textarea
                                        data-block-id={block.id}
                                        className="auto-textarea markdown-source"
                                        value={block.value}
                                        placeholder="Type / for commands"
                                        onBlur={() => setSlashMenuBlockId(null)}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Escape') {
                                            setSlashMenuBlockId(null)
                                          }

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
                                      className="auto-textarea"
                                      value={block.value}
                                      placeholder="Quote"
                                      onChange={(event) => {
                                        resizeTextarea(event.currentTarget)
                                        updateContentBlock(block.id, event.target.value)
                                      }}
                                    />
                                  )}
                                </div>
                              </div>
                            ))}
                          </>
                        ) : (
                          <div className="content-block text-block">
                            <div className="markdown-block-editor">
                              <textarea
                                data-block-id="empty-doc-editor"
                                className="auto-textarea markdown-source"
                                placeholder="Type / for commands"
                                onChange={handleEmptyEditorChange}
                              />
                            </div>
                          </div>
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
