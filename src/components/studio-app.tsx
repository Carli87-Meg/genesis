"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Check,
  Loader2,
  Send,
  Settings2,
  Trash2,
  Box,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Preview3D } from "@/components/preview-3d"
import {
  DEFAULT_BRIDGE_URL,
  opLabel,
  type BridgeResponse,
  type InterpretResult,
  type SolidWorksDocumentPayload,
  type TreeOp,
} from "@/lib/payload"
import { DEFAULT_OPENROUTER_MODEL, OPENROUTER_MODEL_OPTIONS } from "@/lib/openrouter-models"

const EXAMPLES = [
  "Staffa a L 80×50×8 mm, parete 40 mm, boss Ø16, 4 fori Ø6.5, boccola e tavola A3 CM",
  "Piastra 80 × 50 × 8 mm con 4 fori Ø6 agli angoli, raccordi R1",
  "Albero Ø20 mm, lunghezza 80 mm, raccordi R1 alle estremità",
  "Boccola: Ø30 esterno, Ø16 interno, altezza 25 mm",
]

const SETTINGS_KEY = "solidworks-ia-settings"

type Settings = {
  openRouterKey: string
  model: string
  bridgeUrl: string
}

const DEFAULT_SETTINGS: Settings = {
  openRouterKey: "",
  model: DEFAULT_OPENROUTER_MODEL,
  bridgeUrl: DEFAULT_BRIDGE_URL,
}

type ChatMsg = { role: "user" | "assistant"; text: string }

export function StudioApp() {
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS)
  const [showKey, setShowKey] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [ops, setOps] = useState<TreeOp[]>([])
  const [payload, setPayload] = useState<SolidWorksDocumentPayload | null>(null)
  const [job, setJob] = useState<SolidWorksDocumentPayload[] | null>(null)
  const [sendProgress, setSendProgress] = useState<string | null>(null)
  const [dfm, setDfm] = useState<InterpretResult["dfm"]>([])
  const [source, setSource] = useState<"demo" | "openrouter" | null>(null)
  const [sendOpen, setSendOpen] = useState(false)
  const [bridgeResult, setBridgeResult] = useState<BridgeResponse | null>(null)
  const [bridgeErr, setBridgeErr] = useState<string | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Settings>
        const next = { ...DEFAULT_SETTINGS, ...parsed }
        next.openRouterKey = next.openRouterKey.replace(/[\r\n\t]/g, "").trim()
        setSettings(next)
        setDraft(next)
        if (next.openRouterKey.length > 8) {
          void syncSessionKey(next.openRouterKey, false)
        }
      }
    } catch {
      /* ignore */
    }
    setReady(true)
  }, [])

  const visibleOps = useMemo(
    () => ops.filter((o) => o.status !== "discarded"),
    [ops],
  )
  const keyOn = settings.openRouterKey.length > 8

  function liveSettings(): Settings {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Settings>
        return {
          ...DEFAULT_SETTINGS,
          ...settings,
          ...parsed,
          openRouterKey: (parsed.openRouterKey || settings.openRouterKey)
            .replace(/[\r\n\t]/g, "")
            .trim(),
        }
      }
    } catch {
      /* ignore */
    }
    return {
      ...settings,
      openRouterKey: settings.openRouterKey.replace(/[\r\n\t]/g, "").trim(),
    }
  }

  async function interpret(text: string, asFollowUp = false) {
    const q = text.trim()
    if (!q || busy) return
    setBusy(true)
    setPrompt("")
    setMessages((m) => [...m, { role: "user", text: q }])
    try {
      const live = liveSettings()
      const key = live.openRouterKey.replace(/[^\x20-\x7E]/g, "")
      const res = await fetch("/api/interpret", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...(key
            ? {
                Authorization: `Bearer ${key}`,
                "x-openrouter-key": key,
                "x-openrouter-model": live.model,
              }
            : {}),
        },
        body: JSON.stringify({
          prompt: q,
          followUp: asFollowUp && Boolean(payload),
          previous: asFollowUp ? payload ?? undefined : undefined,
          openRouterKey: key || undefined,
          token: key || undefined,
          model: live.model,
          useStoredKey: Boolean(key),
        }),
      })
      const data = (await res.json()) as InterpretResult & { error?: string }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const operations = data.operations ?? data.payload?.operations ?? []
      if (operations.length === 0) {
        throw new Error(data.error || data.warning || "Nessuna operazione dal modello.")
      }
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: data.warning ? `${data.summary}\n${data.warning}` : data.summary,
        },
      ])
      setOps(operations.map((o) => ({ ...o, status: "accepted" as const })))
      setPayload(data.payload)
      setJob(data.job && data.job.length > 1 ? data.job : null)
      setDfm(data.dfm ?? [])
      setSource(data.source)
    } catch (err) {
      setSource(null)
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `Errore interpretazione: ${err instanceof Error ? err.message : String(err)}`,
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  function move(i: number, dir: -1 | 1) {
    setOps((list) => {
      const j = i + dir
      if (j < 0 || j >= list.length) return list
      const next = [...list]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function editNumber(id: string, field: string, value: number) {
    setOps((list) =>
      list.map((o) => (o.id === id ? ({ ...o, [field]: value } as TreeOp) : o)),
    )
  }

  async function sendToSolidWorks() {
    const active = ops.filter((o) => o.status !== "discarded")
    if (active.length === 0 && !job) return
    const docs: SolidWorksDocumentPayload[] =
      job && job.length > 1
        ? job.map(ensureSavePath)
        : [
            ensureSavePath(
              payload
                ? { ...payload, operations: active }
                : {
                    schemaVersion: 2,
                    units: "mm",
                    document: { type: "part", name: "Pezzo", attachToActive: false },
                    variables: [],
                    configurations: [],
                    operations: active,
                  },
            ),
          ]
    setSendBusy(true)
    setBridgeErr(null)
    setBridgeResult(null)
    setSendProgress(null)
    setSendOpen(true)
    const mergedSteps: BridgeResponse["steps"] = []
    let last: BridgeResponse | null = null
    try {
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i]
        setSendProgress(
          `Documento ${i + 1}/${docs.length}: ${doc.document.name} (${doc.document.type})`,
        )
        const res = await fetch("/api/solidworks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload: doc, bridgeUrl: settings.bridgeUrl }),
        })
        const data = (await res.json()) as BridgeResponse
        last = data
        for (const s of data.steps ?? []) mergedSteps.push(s)
        if (!data.ok) {
          setBridgeErr(data.error || `Invio fallito su ${doc.document.name}`)
          setBridgeResult({ ...data, steps: mergedSteps })
          return
        }
      }
      if (last) setBridgeResult({ ...last, steps: mergedSteps })
    } catch (err) {
      setBridgeErr(err instanceof Error ? err.message : String(err))
    } finally {
      setSendBusy(false)
      setSendProgress(null)
    }
  }

  function ensureSavePath(p: SolidWorksDocumentPayload): SolidWorksDocumentPayload {
    if (p.document.savePath) return p
    const ext =
      p.document.type === "assembly"
        ? "SLDASM"
        : p.document.type === "drawing"
          ? "SLDDRW"
          : "SLDPRT"
    const folder = p.document.type === "drawing" ? "Disegni" : "CAD"
    return {
      ...p,
      document: {
        ...p.document,
        savePath: `${folder}/${p.document.name}.${ext}`,
        snapshotPath: p.document.snapshotPath ?? `Export/${p.document.name}.jpg`,
      },
    }
  }

  function persistSettings(next: Settings) {
    const clean: Settings = {
      ...next,
      openRouterKey: next.openRouterKey.replace(/[\r\n\t]/g, "").trim(),
    }
    setDraft(clean)
    setSettings(clean)
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(clean))
    return clean
  }

  async function syncSessionKey(key: string, verify: boolean) {
    const clean = key.replace(/[\r\n\t]/g, "").trim()
    if (clean.length <= 8) {
      await fetch("/api/or-session", { method: "DELETE" })
      return { stored: false, valid: false as boolean | undefined, status: 0, detail: "" }
    }
    const res = await fetch("/api/or-session", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openRouterKey: clean, verify }),
    })
    return (await res.json()) as {
      stored?: boolean
      valid?: boolean
      status?: number
      detail?: string
    }
  }

  async function saveSettings() {
    const el = document.getElementById("or-key") as HTMLInputElement | null
    const fromDom = el?.value ?? draft.openRouterKey
    const clean = persistSettings({ ...draft, openRouterKey: fromDom })
    setSettingsOpen(false)
    if (!clean.openRouterKey) {
      await syncSessionKey("", false)
      setNotice("Chiave rimossa. Resta la demo locale.")
      setTimeout(() => setNotice(null), 5000)
      return
    }
    const check = await syncSessionKey(clean.openRouterKey, true)
    const tail = `${clean.openRouterKey.slice(0, 8)}…${clean.openRouterKey.slice(-4)}`
    setNotice(
      check.valid === false
        ? `Chiave salvata (${tail}) ma OpenRouter l'ha rifiutata${check.status ? ` (${check.status})` : ""}. I pezzi non verranno creati finché la chiave non è valida. La demo non parte in automatico.`
        : `Chiave salvata (${tail}). OpenRouter ok.`,
    )
    setTimeout(() => setNotice(null), 8000)
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Caricamento…
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Box className="size-5" />
          <div>
            <h1 className="text-sm font-semibold leading-none">Solidworks_IA</h1>
            <p className="text-xs text-muted-foreground">
              Chat → albero parametrico → SolidWorks via bridge HTTP→COM
            </p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge variant={keyOn ? "default" : "secondary"}>
            {keyOn ? "OpenRouter" : "Demo"}
          </Badge>
          {keyOn && source === "demo" && (
            <Badge variant="outline">interprete: demo</Badge>
          )}
          {source === "openrouter" && (
            <Badge variant="outline">interprete: LLM</Badge>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(settings)
              setSettingsOpen(true)
            }}
          >
            <Settings2 className="size-3.5" />
            Impostazioni
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={visibleOps.length === 0 || sendBusy}
            onClick={() => void sendToSolidWorks()}
          >
            {sendBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Invia a SolidWorks
          </Button>
        </div>
      </header>

      {notice && (
        <div className="border-b bg-muted px-4 py-2 text-sm">✓ {notice}</div>
      )}

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-3">
        <section className="flex min-h-[320px] flex-col border-b lg:border-r lg:border-b-0">
          <div className="border-b px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Chat di progetto
          </div>
          <ScrollArea className="flex-1">
            <div className="space-y-3 p-4">
              {messages.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">Nessun messaggio</p>
                  <p className="mt-1">
                    Descrivi il pezzo in italiano o inglese, con quote in millimetri.
                  </p>
                </div>
              )}
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={
                    m.role === "user"
                      ? "ml-8 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                      : "mr-8 rounded-lg bg-muted px-3 py-2 text-sm"
                  }
                >
                  {m.text}
                </div>
              ))}
              {busy && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Interpretazione…
                </div>
              )}
            </div>
          </ScrollArea>
          <div className="space-y-2 border-t p-3">
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <Button
                  key={ex}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="h-auto max-w-full whitespace-normal py-1 text-left"
                  onClick={() => void interpret(ex, false)}
                >
                  {ex}
                </Button>
              ))}
            </div>
            <div className="flex gap-2">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Staffa a L 80×50×8 mm, parete 40 mm, boccola e tavola A3…"
                className="min-h-[72px] resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void interpret(prompt, true)
                  }
                }}
              />
              <Button
                type="button"
                className="self-end"
                disabled={busy || !prompt.trim()}
                onClick={() => void interpret(prompt, true)}
              >
                Invia
              </Button>
            </div>
          </div>
        </section>

        <section className="flex min-h-[280px] flex-col border-b lg:border-r lg:border-b-0">
          <div className="border-b px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Anteprima 3D
          </div>
          <div className="min-h-0 flex-1">
            <Preview3D operations={visibleOps} />
          </div>
        </section>

        <section className="flex min-h-[280px] flex-col">
          <div className="border-b px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Timeline operazioni
          </div>
          <ScrollArea className="flex-1">
            <div className="space-y-2 p-3">
              {ops.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">Nessuna operazione</p>
                  <p className="mt-1">
                    L&apos;albero feature è la fonte di verità: accetta, scarta, riordina, modifica le quote.
                  </p>
                </div>
              )}
              {ops.map((op, i) => (
                <div
                  key={op.id + i}
                  className={`rounded-lg border p-2 text-sm ${op.status === "discarded" ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-1">
                    <span className="font-medium">{op.name || opLabel(op)}</span>
                    <Badge variant="outline" className="ml-auto">
                      {op.type}
                    </Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Button type="button" size="icon-xs" variant="ghost" onClick={() => move(i, -1)}>
                      <ArrowUp />
                    </Button>
                    <Button type="button" size="icon-xs" variant="ghost" onClick={() => move(i, 1)}>
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      onClick={() =>
                        setOps((list) =>
                          list.map((o, idx) =>
                            idx === i
                              ? {
                                  ...o,
                                  status: o.status === "discarded" ? "accepted" : "discarded",
                                }
                              : o,
                          ),
                        )
                      }
                    >
                      {op.status === "discarded" ? <Check /> : <Trash2 />}
                    </Button>
                    {"depth" in op && typeof op.depth === "number" && (
                      <label className="ml-auto flex items-center gap-1 text-xs">
                        profondità
                        <Input
                          className="h-6 w-16"
                          type="number"
                          value={op.depth}
                          onChange={(e) => editNumber(op.id, "depth", Number(e.target.value))}
                        />
                      </label>
                    )}
                    {"radius" in op && typeof op.radius === "number" && (
                      <label className="ml-auto flex items-center gap-1 text-xs">
                        R
                        <Input
                          className="h-6 w-16"
                          type="number"
                          value={op.radius}
                          onChange={(e) => editNumber(op.id, "radius", Number(e.target.value))}
                        />
                      </label>
                    )}
                    {"diameter" in op && typeof op.diameter === "number" && (
                      <label className="ml-auto flex items-center gap-1 text-xs">
                        Ø
                        <Input
                          className="h-6 w-16"
                          type="number"
                          value={op.diameter}
                          onChange={(e) => editNumber(op.id, "diameter", Number(e.target.value))}
                        />
                      </label>
                    )}
                  </div>
                </div>
              ))}
              {dfm.length > 0 && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs">
                  <p className="mb-1 font-medium">DFM</p>
                  {dfm.map((d, i) => (
                    <p key={i}>
                      {d.severity === "error" ? "●" : "○"} {d.message}
                    </p>
                  ))}
                </div>
              )}
              {source && (
                <p className="px-1 text-[11px] text-muted-foreground">
                  Fonte: {source === "demo" ? "demo locale" : "OpenRouter"}
                {source === "openrouter" && settings.model ? ` · ${settings.model}` : ""}
                {" · "}schema v2
                {job ? ` · kit ${job.length} documenti` : ""}
                </p>
              )}
            </div>
          </ScrollArea>
        </section>
      </main>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>Impostazioni</DialogTitle>
            <DialogDescription>
              La chiave OpenRouter resta nel browser (localStorage) e una copia locale
              serve solo a questo PC (mai git). Senza chiave: demo. Con chiave rifiutata
              da OpenRouter non parte la demo, così non nasce il pezzo sbagliato.
              Modelli: consigliato / veloce / qualità / economico — dettagli nel README
              (sezione OpenRouter) e nella nota CADTM sui modelli.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="or-key">Chiave OpenRouter</Label>
              <div className="flex gap-2">
                <Input
                  id="or-key"
                  type={showKey ? "text" : "password"}
                  placeholder="Incolla sk-or-v1-…"
                  autoComplete="off"
                  value={draft.openRouterKey}
                  onChange={(e) => setDraft((s) => ({ ...s, openRouterKey: e.target.value }))}
                  onBlur={() => {
                    const trimmed = draft.openRouterKey.replace(/[\r\n\t]/g, "").trim()
                    if (trimmed.length > 8) persistSettings({ ...draft, openRouterKey: trimmed })
                  }}
                />
                <Button type="button" variant="outline" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? "Nascondi" : "Mostra"}
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="model">Modello</Label>
              <select
                id="model"
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={draft.model}
                onChange={(e) => setDraft((s) => ({ ...s, model: e.target.value }))}
              >
                {OPENROUTER_MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {!OPENROUTER_MODEL_OPTIONS.some((m) => m.id === draft.model) && draft.model ? (
                  <option value={draft.model}>{draft.model} (salvato)</option>
                ) : null}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bridge">URL bridge SolidWorks</Label>
              <Input
                id="bridge"
                value={draft.bridgeUrl}
                onChange={(e) => setDraft((s) => ({ ...s, bridgeUrl: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            {draft.openRouterKey && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDraft((s) => ({ ...s, openRouterKey: "" }))}
              >
                Rimuovi chiave
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setSettingsOpen(false)}>
              Annulla
            </Button>
            <Button type="button" onClick={() => void saveSettings()}>
              Salva
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="sm:max-w-lg" showCloseButton>
          <DialogHeader>
            <DialogTitle>Invia a SolidWorks</DialogTitle>
            <DialogDescription>
              Payload schema v2 verso il bridge locale. Traversata feature con
              FeatureByPositionReverse + GetTypeName2 (mai SelectByID2).
            </DialogDescription>
          </DialogHeader>
          {sendBusy && (
            <p className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />{" "}
              {sendProgress || "Esecuzione COM in corso…"}
            </p>
          )}
          {bridgeErr && (
            <pre className="max-h-40 overflow-auto rounded-md bg-destructive/10 p-2 text-xs whitespace-pre-wrap">
              {bridgeErr}
            </pre>
          )}
          {bridgeResult && (
            <div className="max-h-64 space-y-2 overflow-auto text-xs">
              <p>
                attach: {bridgeResult.attachPath || "—"} · SW {bridgeResult.version || "—"} ·{" "}
                {bridgeResult.document || "nessun documento"}
              </p>
              {(bridgeResult.steps ?? []).map((s, i) => (
                <p key={i} className={s.ok ? "" : "text-destructive"}>
                  {s.ok ? "OK" : "FAIL"} {s.op} — {s.detail}
                </p>
              ))}
              {(bridgeResult.features ?? []).length > 0 && (
                <p className="text-muted-foreground">
                  Feature: {bridgeResult.features!.map((f) => `${f.name} (${f.typeName})`).join(", ")}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSendOpen(false)}>
              Chiudi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
