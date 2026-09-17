import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { fileLanguage } from '../../shared/site-file'
import { IconButton } from '../ui/icon-button'
import { Redo2, Undo2, Search } from 'lucide-react'

export type EditorSession = { state?: EditorState; scrollTop?: number; options?: Compartment; language?: Compartment; comparison?: Compartment }

const loadLanguage = async (path: string) => {
  switch (fileLanguage(path)) {
    case 'html': return (await import('@codemirror/lang-html')).html()
    case 'css': return (await import('@codemirror/lang-css')).css()
    case 'javascript': return (await import('@codemirror/lang-javascript')).javascript()
    case 'json': return (await import('@codemirror/lang-json')).json()
    case 'xml': return (await import('@codemirror/lang-xml')).xml()
    default: return []
  }
}

const theme = EditorView.theme({
  '&': { fontSize: '13px', backgroundColor: '#fff', color: '#0f172a', height: '100%', minHeight: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.7' },
  '.cm-content': { padding: '16px 0', caretColor: '#0f172a' },
  '.cm-selectionBackground': { backgroundColor: '#e2e8f0' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: '#bfdbfe' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#0f172a' },
  '.cm-gutters': { backgroundColor: '#f8fafc', color: '#64748b', borderRight: '1px solid #e2e8f0' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#f1f5f9' },
  '.cm-panels': { backgroundColor: '#f8fafc' },
  '.cm-search': { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '8px' },
  '.cm-textfield': { maxWidth: '180px' },
})

export default function CodeEditor({ path, content, original, readOnly, compare, session, onChange }: {
  path: string; content: string; original: string; readOnly: boolean; compare: boolean
  session: EditorSession; onChange: (content: string) => void
}) {
  const [extensionError, setExtensionError] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const change = useRef(onChange)
  const initialContent = useRef(content)
  useLayoutEffect(() => { change.current = onChange }, [onChange])
  useLayoutEffect(() => { initialContent.current = content }, [content])

  useLayoutEffect(() => {
    session.options ??= new Compartment()
    session.language ??= new Compartment()
    session.comparison ??= new Compartment()
    const state = session.state ?? EditorState.create({ doc: initialContent.current, extensions: [
      basicSetup, theme, session.language.of([]), session.comparison.of([]),
      EditorState.lineSeparator.of(initialContent.current.includes('\r\n') ? '\r\n' : '\n'),
      session.options.of([]),
      EditorView.contentAttributes.of({ 'aria-label': `Source code: ${path}`, spellcheck: 'false' }),
    ] })
    const view = new EditorView({ state, parent: host.current!, dispatchTransactions(transactions) {
      view.update(transactions)
      session.state = view.state
      if (transactions.some((transaction) => transaction.docChanged)) change.current(view.state.sliceDoc())
    } })
    editor.current = view
    view.scrollDOM.scrollTop = session.scrollTop ?? 0
    return () => {
      session.state = view.state
      session.scrollTop = view.scrollDOM.scrollTop
      view.destroy()
      editor.current = null
    }
  }, [session, path])

  useEffect(() => {
    editor.current?.dispatch({ effects: session.options!.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    ]) })
  }, [readOnly, session])

  useEffect(() => {
    let cancelled = false
    void loadLanguage(path).then((extension) => {
      if (!cancelled) editor.current?.dispatch({ effects: session.language!.reconfigure(extension) })
    }).catch(() => { if (!cancelled) setExtensionError('Syntax highlighting could not load. You can still edit as plain text.') })
    return () => { cancelled = true }
  }, [path, session])

  useEffect(() => {
    let cancelled = false
    if (!compare) editor.current?.dispatch({ effects: session.comparison!.reconfigure([]) })
    else void import('@codemirror/merge').then(({ unifiedMergeView }) => {
      if (!cancelled) editor.current?.dispatch({ effects: session.comparison!.reconfigure(unifiedMergeView({ original, mergeControls: false })) })
    }).catch(() => { if (!cancelled) setExtensionError('Comparison could not load. Your draft is still available.') })
    return () => { cancelled = true }
  }, [compare, original, session])

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/60 px-3 py-2">
      <span className="text-xs text-slate-500">{compare ? 'Changes compared with saved content' : readOnly ? 'Read only' : 'Editing source'}</span>
      <div className="flex gap-1">
        <IconButton label="Find in file" variant="ghost" onClick={() => { if (editor.current) openSearchPanel(editor.current) }}><Search aria-hidden="true" className="size-4" /></IconButton>
        <IconButton label="Undo edit" disabled={readOnly} variant="ghost" onClick={() => { if (editor.current) undo(editor.current) }}><Undo2 aria-hidden="true" className="size-4" /></IconButton>
        <IconButton label="Redo edit" disabled={readOnly} variant="ghost" onClick={() => { if (editor.current) redo(editor.current) }}><Redo2 aria-hidden="true" className="size-4" /></IconButton>
      </div>
    </div>
    {extensionError && <p role="alert" className="px-3 py-2 text-xs text-amber-800">{extensionError}</p>}
    <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
  </div>
}
