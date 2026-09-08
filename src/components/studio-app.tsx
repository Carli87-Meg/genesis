"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  FileSpreadsheet,
  Layers,
  Loader2,
  PanelRight,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Frame,
  Trash2,
  X,
} from "lucide-react"
import { cn } from "cn"
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
import {
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_MODEL_OPTIONS,
  SETTINGS_MODEL_REV,
  resolveStoredModel,
} from "@/lib/openrouter-models"

const STAFFA =
  "Staffa a L 80×50×8 mm, parete 40 mm, boss Ø16, 4 fori Ø6.5, boccola e tavola A3 CM"

const SCALA =
  "Modulo scala metallica (studio Guidetti, non l'intero progetto): 2 fiancate 40×8×600 mm distanti 700 mm, 2 scalini 700×220×6 mm, 1 piede 80×80×8 mm. Fori Ø8. Assieme con mate coincidenti sulle facce e concentrici sui fori. Tavola A3 CM Cartiglio_CM."

const ACTIONS = [
  {
    id: "pezzo",
    label: "Crea pezzo",
    hint: "Piastra forata",
    icon: Plus,
    prompt: "Piastra 80 × 50 × 8 mm con 4 fori Ø6 agli angoli",
    followUp: false,
  },
  {
    id: "tavola",
    label: "Tavola A3 CM",
    hint: "Cartiglio_CM",
    icon: FileSpreadsheet,
    prompt: "Tavola A3 CM con Cartiglio_CM, viste in 1° angolo del pezzo o assieme corrente",
    followUp: true,
  },
  {
    id: "assieme",
    label: "Assieme",
    hint: "Perno e rondella",
    icon: Layers,
    prompt:
      "Assieme: piastra 80×50×8 mm, perno Ø8×24 mm, rondella Ø18/Ø8.2×2 mm, mate concentrici e coincidenti sulle facce",
    followUp: false,
  },
  { id: "staffa", label: "Staffa a L", hint: "Kit 4 documenti", icon: Box, prompt: STAFFA, followUp: false },
  {
    id: "scala",
    label: "Scala / telaio",
    hint: "Fiancate e scalini",
    icon: Frame,
    prompt: SCALA,
    followUp: false,
  },
] as const

const SETTINGS_KEY = "solidworks-ia-settings"

type Settings = {
  openRouterKey: string
  model: string
  bridgeUrl: string
  modelRev?: number
}

const DEFAULT_SETTINGS: Settings = {
  openRouterKey: "",
  model: DEFAULT_OPENROUTER_MODEL,
  bridgeUrl: DEFAULT_BRIDGE_URL,
  modelRev: SETTINGS_MODEL_REV,
}

type ChatMsg = {
  role: "user" | "assistant"
  text: string
  error?: boolean
  proposal?: {
    opCount: number
    jobCount?: number
    names: string[]
    source: "demo" | "openrouter"
  }
}

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
  const [swOk, setSwOk] = useState<boolean | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [show3d, setShow3d] = useState(false)
  const [isLg, setIsLg] = useState(false)
  const [sessionStored, setSessionStored] = useState(false)
  const chatEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Settings>
        const next = { ...DEFAULT_SETTINGS, ...parsed }
        next.openRouterKey = next.openRouterKey.replace(/[\r\n\t]/g, "").trim()
        const rev = parsed.modelRev ?? 0
        next.model = resolveStoredModel(parsed.model, rev)
        next.modelRev = SETTINGS_MODEL_REV
        setSettings(next)
        setDraft(next)
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        if (next.openRouterKey.length > 8) {
          void syncSessionKey(next.openRouterKey, false)
        }
      }
    } catch {
      /* ignore */
    }
    void (async () => {
      try {
        const res = await fetch("/api/or-session?verify=1", { cache: "no-store" })
        const data = (await res.json()) as { stored?: boolean; valid?: boolean }
        setSessionStored(Boolean(data.stored && data.valid !== false))
      } catch {
        setSessionStored(false)
      } finally {
        setReady(true)
      }
    })()
  }, [])

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    const apply = () => setIsLg(mq.matches)
    apply()
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch("/api/solidworks", { cache: "no-store" })
        const data = (await res.json()) as BridgeResponse
        if (alive) setSwOk(Boolean(data.ok))
      } catch {
        if (alive) setSwOk(false)
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 15000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, busy])

  const visibleOps = useMemo(() => ops.filter((o) => o.status !== "discarded"), [ops])
  const keyOn = settings.openRouterKey.length > 8 || sessionStored
  const canExecute = visibleOps.length > 0 || Boolean(job && job.length > 1)

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
          model: resolveStoredModel(
            parsed.model || settings.model,
            parsed.modelRev ?? settings.modelRev ?? 0,
          ),
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
          useStoredKey: keyOn,
        }),
      })
      const data = (await res.json()) as InterpretResult & { error?: string }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const operations = data.operations ?? data.payload?.operations ?? []
      if (operations.length === 0) {
        throw new Error(data.error || data.warning || "Nessuna operazione dal modello.")
      }
      const names =
        data.job && data.job.length > 1
          ? data.job.map((d) => d.document.name)
          : [data.payload?.document.name || "Pezzo"]
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: data.warning ? `${data.summary}\n${data.warning}` : data.summary,
          proposal: {
            opCount: operations.length,
            jobCount: data.job?.length,
            names,
            source: data.source,
          },
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
          error: true,
          text: `Non ho potuto proporre il pezzo: ${err instanceof Error ? err.message : String(err)}`,
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
    setOps((list) => list.map((o) => (o.id === id ? ({ ...o, [field]: value } as TreeOp) : o)))
  }

  async function postToBridge(doc: SolidWorksDocumentPayload): Promise<BridgeResponse> {
    const res = await fetch("/api/solidworks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: doc, bridgeUrl: settings.bridgeUrl }),
    })
    return (await res.json()) as BridgeResponse
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
    let failed: string | null = null
    try {
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i]
        setSendProgress(
          `Documento ${i + 1}/${docs.length}: ${doc.document.name} (${doc.document.type})`,
        )
        let data = await postToBridge(doc)
        if (!data.ok && /80010108|RPC_E_DISCONNECTED|disconnesso/i.test(data.error || "")) {
          setSendProgress(
            `COM disconnesso, nuovo tentativo ${i + 1}/${docs.length}: ${doc.document.name}`,
          )
          await new Promise((r) => setTimeout(r, 2500))
          data = await postToBridge(doc)
        }
        last = data
        for (const s of data.steps ?? []) mergedSteps.push(s)
        if (!data.ok) {
          failed = data.error || `Invio fallito su ${doc.document.name}`
          setBridgeErr(failed)
          setBridgeResult({ ...data, steps: mergedSteps })
          break
        }
        if (i < docs.length - 1) await new Promise((r) => setTimeout(r, 1200))
      }
      if (!failed && last) setBridgeResult({ ...last, steps: mergedSteps })
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          error: Boolean(failed),
          text: failed
            ? `Esecuzione interrotta: ${failed}`
            : `Eseguito in SolidWorks: ${docs.map((d) => d.document.name).join(", ")}.`,
        },
      ])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setBridgeErr(msg)
      setMessages((m) => [
        ...m,
        { role: "assistant", error: true, text: `Bridge irraggiungibile: ${msg}` },
      ])
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
      modelRev: SETTINGS_MODEL_REV,
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
      setSessionStored(false)
      return { stored: false, valid: false as boolean | undefined, status: 0, detail: "" }
    }
    const res = await fetch("/api/or-session", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openRouterKey: clean, verify }),
    })
    const data = (await res.json()) as {
      stored?: boolean
      valid?: boolean
      status?: number
      detail?: string
    }
    setSessionStored(Boolean(data.stored && data.valid !== false))
    return data
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

  function resetConversation() {
    setMessages([])
    setOps([])
    setPayload(null)
    setJob(null)
    setDfm([])
    setSource(null)
    setBridgeErr(null)
    setBridgeResult(null)
    setPrompt("")
  }

  if (!ready) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-primary" />
        <p>Caricamento copilot…</p>
      </div>
    )
  }

  const rail = (
    <PianoRail
      ops={ops}
      job={job}
      dfm={dfm}
      source={source}
      model={settings.model}
      show3d={show3d}
      visibleOps={visibleOps}
      onToggle3d={() => setShow3d((v) => !v)}
      onMove={move}
      onEdit={editNumber}
      onToggleOp={(i) =>
        setOps((list) =>
          list.map((o, idx) =>
            idx === i
              ? { ...o, status: o.status === "discarded" ? "accepted" : "discarded" }
              : o,
          ),
        )
      }
    />
  )

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border/80 bg-background/75 px-3 py-2.5 backdrop-blur-md sm:px-5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20">
          <Box className="size-4" />
        </div>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold leading-none">Solidworks_IA</h1>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            Copilot sul CAD aperto · schema v2
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <span
            className={cn(
              "hidden items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] sm:inline-flex",
              swOk ? "border-primary/25 bg-primary/10 text-foreground" : "border-border text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                swOk === null ? "bg-muted-foreground/50" : swOk ? "bg-emerald-400" : "bg-destructive",
              )}
            />
            {swOk === null ? "SolidWorks…" : swOk ? "SolidWorks collegato" : "Bridge off"}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
              keyOn ? "border-primary/25 bg-primary/10" : "border-border text-muted-foreground",
            )}
          >
            <span className={cn("size-1.5 rounded-full", keyOn ? "bg-primary" : "bg-muted-foreground/50")} />
            {keyOn ? "OpenRouter" : "Demo"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            onClick={() => setPanelOpen(true)}
            aria-label="Apri piano"
          >
            <PanelRight className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => {
              setDraft(settings)
              setSettingsOpen(true)
            }}
          >
            <Settings2 className="size-3.5" />
            <span className="hidden sm:inline">Impostazioni</span>
          </Button>
        </div>
      </header>

      {notice && (
        <div className="border-b border-primary/20 bg-primary/10 px-4 py-2 text-sm text-foreground">
          {notice}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <ScrollArea className="flex-1">
            <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6 sm:py-8">
              {messages.length === 0 && !busy && (
                <div className="py-6 text-center sm:py-12">
                  <p className="text-[11px] font-medium tracking-[0.18em] text-primary uppercase">
                    Copilot SolidWorks
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold sm:text-3xl">Cosa vuoi fare in SolidWorks?</h2>
                  <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                    Descrivi il pezzo o l&apos;azione. Il copilot propone operazioni parametriche, poi{" "}
                    <span className="text-foreground">Esegui</span> le manda al CAD aperto (bridge HTTP→COM, non
                    un add-in).
                  </p>
                  <div className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {ACTIONS.map((a) => (
                      <Button
                        key={a.id}
                        type="button"
                        variant="outline"
                        className="h-auto flex-col items-start gap-1.5 rounded-2xl border-border/80 bg-card/60 px-3 py-3 text-left shadow-sm hover:border-primary/35 hover:bg-accent/40"
                        disabled={busy}
                        onClick={() => void interpret(a.prompt, a.followUp && Boolean(payload))}
                      >
                        <a.icon className="size-4 text-primary" />
                        <span className="text-xs font-medium text-foreground">{a.label}</span>
                        <span className="text-[11px] font-normal text-muted-foreground">{a.hint}</span>
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={
                      m.role === "user"
                        ? "max-w-[92%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm"
                        : m.error
                          ? "max-w-[92%] rounded-2xl rounded-bl-md border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm leading-relaxed"
                          : "max-w-[92%] rounded-2xl rounded-bl-md border border-border/70 bg-card/80 px-4 py-2.5 text-sm leading-relaxed shadow-sm"
                    }
                  >
                    {m.role === "assistant" && !m.error && (
                      <p className="mb-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                        Proposta
                      </p>
                    )}
                    {m.error && (
                      <p className="mb-1.5 text-[10px] font-medium tracking-wider text-destructive uppercase">
                        Errore
                      </p>
                    )}
                    <p className="whitespace-pre-wrap">{m.text}</p>
                    {m.proposal && (
                      <div className="mt-3 space-y-2.5 border-t border-border/50 pt-3">
                        <p className="text-xs text-muted-foreground">
                          {m.proposal.names.join(" · ")} · {m.proposal.opCount} operazioni
                          {m.proposal.jobCount && m.proposal.jobCount > 1
                            ? ` · kit ${m.proposal.jobCount} documenti`
                            : ""}
                          {" · "}
                          {m.proposal.source === "demo" ? "demo" : "OpenRouter"}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          className="rounded-full"
                          disabled={!canExecute || sendBusy}
                          onClick={() => void sendToSolidWorks()}
                        >
                          {sendBusy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Play className="size-3.5" />
                          )}
                          Esegui in SolidWorks
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {busy && (
                <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-primary" />
                  Il copilot sta traducendo in operazioni CAD…
                </div>
              )}
              <div ref={chatEnd} />
            </div>
          </ScrollArea>

          <div className="border-t border-border/80 bg-background/80 p-3 backdrop-blur-md sm:p-4">
            <div className="mx-auto w-full max-w-2xl space-y-2">
              {messages.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {ACTIONS.map((a) => (
                    <Button
                      key={a.id}
                      type="button"
                      variant="outline"
                      size="xs"
                      className="rounded-full"
                      disabled={busy}
                      onClick={() => void interpret(a.prompt, a.followUp && Boolean(payload))}
                    >
                      {a.label}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="rounded-full"
                    disabled={!payload || busy}
                    onClick={() => {
                      if (prompt.trim()) void interpret(prompt, true)
                    }}
                  >
                    <RotateCcw className="size-3" />
                    Revisione
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="rounded-full"
                    onClick={resetConversation}
                  >
                    Nuova chat
                  </Button>
                </div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Modulo scala metallica, fiancate, scalini, tavola A3 CM…"
                  className="min-h-[84px] resize-none rounded-2xl bg-card/70 px-3.5 py-3 sm:min-h-[72px]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      void interpret(prompt, Boolean(payload))
                    }
                  }}
                />
                <div className="flex gap-2 sm:w-[7.5rem] sm:flex-col sm:gap-1.5">
                  <Button
                    type="button"
                    className="flex-1 rounded-full sm:self-stretch"
                    disabled={busy || !prompt.trim()}
                    onClick={() => void interpret(prompt, Boolean(payload))}
                  >
                    Proponi
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="flex-1 rounded-full sm:self-stretch"
                    disabled={!canExecute || sendBusy}
                    onClick={() => void sendToSolidWorks()}
                  >
                    {sendBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    Esegui
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </main>

        <aside className="hidden w-[19.5rem] shrink-0 flex-col border-l border-border/80 bg-sidebar/80 lg:flex">
          {isLg ? rail : null}
        </aside>
      </div>

      {panelOpen && !isLg && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label="Chiudi piano"
            onClick={() => setPanelOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 flex w-[min(100%,20rem)] flex-col bg-sidebar shadow-2xl">
            <div className="flex items-center justify-between border-b border-border/80 px-3 py-2.5">
              <span className="text-sm font-medium">Piano</span>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setPanelOpen(false)}>
                <X className="size-4" />
              </Button>
            </div>
            {rail}
          </div>
        </div>
      )}

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>Impostazioni</DialogTitle>
            <DialogDescription>
              Chiave OpenRouter solo su questo PC (localStorage, mai git). Senza chiave: demo.
              Con chiave, un errore OpenRouter non cade sulla demo. Consigliato / Veloce / Qualità:
              default Claude Sonnet 4.6.
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
                {(
                  [
                    ["consigliato", "Consigliato"],
                    ["veloce", "Veloce"],
                    ["qualita", "Massima qualità"],
                    ["economico", "Economico"],
                  ] as const
                ).map(([tag, label]) => {
                  const opts = OPENROUTER_MODEL_OPTIONS.filter((m) => m.tag === tag)
                  if (opts.length === 0) return null
                  return (
                    <optgroup key={tag} label={label}>
                      {opts.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  )
                })}
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
              <Button type="button" variant="ghost" onClick={() => setDraft((s) => ({ ...s, openRouterKey: "" }))}>
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
            <DialogTitle>Esegui in SolidWorks</DialogTitle>
            <DialogDescription>
              Payload schema v2 verso il bridge locale. Un documento alla volta; se COM si stacca, ritento.
            </DialogDescription>
          </DialogHeader>
          {sendBusy && (
            <p className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" /> {sendProgress || "Esecuzione COM in corso…"}
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

function PianoRail({
  ops,
  job,
  dfm,
  source,
  model,
  show3d,
  visibleOps,
  onToggle3d,
  onMove,
  onEdit,
  onToggleOp,
}: {
  ops: TreeOp[]
  job: SolidWorksDocumentPayload[] | null
  dfm: InterpretResult["dfm"]
  source: "demo" | "openrouter" | null
  model: string
  show3d: boolean
  visibleOps: TreeOp[]
  onToggle3d: () => void
  onMove: (i: number, dir: -1 | 1) => void
  onEdit: (id: string, field: string, value: number) => void
  onToggleOp: (i: number) => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/80 px-4 py-3">
        <p className="text-[10px] font-medium tracking-[0.16em] text-primary uppercase">Piano</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">Albero e kit · secondario</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {job && job.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {job.map((d) => (
                <Badge key={d.document.name} variant="outline">
                  {d.document.type === "drawing"
                    ? "Tavola"
                    : d.document.type === "assembly"
                      ? "Assieme"
                      : "Parte"}{" "}
                  {d.document.name}
                </Badge>
              ))}
            </div>
          )}
          {ops.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/80 bg-background/30 p-3 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Nessuna proposta</p>
              <p className="mt-1 leading-relaxed">Dopo «Proponi» qui vedi le feature da eseguire nel CAD.</p>
            </div>
          )}
          {ops.map((op, i) => (
            <div
              key={op.id + i}
              className={`rounded-xl border border-border/70 bg-background/40 p-2.5 text-xs ${op.status === "discarded" ? "opacity-50" : ""}`}
            >
              <div className="flex items-center gap-1">
                <span className="font-medium">{op.name || opLabel(op)}</span>
                <Badge variant="outline" className="ml-auto">
                  {op.type}
                </Badge>
              </div>
              <div className="mt-1 flex flex-wrap gap-0.5">
                <Button type="button" size="icon-xs" variant="ghost" onClick={() => onMove(i, -1)}>
                  <ArrowUp />
                </Button>
                <Button type="button" size="icon-xs" variant="ghost" onClick={() => onMove(i, 1)}>
                  <ArrowDown />
                </Button>
                <Button type="button" size="icon-xs" variant="ghost" onClick={() => onToggleOp(i)}>
                  {op.status === "discarded" ? <Check /> : <Trash2 />}
                </Button>
                {"depth" in op && typeof op.depth === "number" && (
                  <label className="ml-auto flex items-center gap-1">
                    mm
                    <Input
                      className="h-6 w-14"
                      type="number"
                      value={op.depth}
                      onChange={(e) => onEdit(op.id, "depth", Number(e.target.value))}
                    />
                  </label>
                )}
                {"diameter" in op && typeof op.diameter === "number" && (
                  <label className="ml-auto flex items-center gap-1">
                    Ø
                    <Input
                      className="h-6 w-14"
                      type="number"
                      value={op.diameter}
                      onChange={(e) => onEdit(op.id, "diameter", Number(e.target.value))}
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
              {source === "demo" ? "demo locale" : "OpenRouter"}
              {source === "openrouter" && model ? ` · ${model}` : ""} · schema v2
            </p>
          )}
        </div>
      </ScrollArea>
      <div className="border-t">
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50"
          onClick={onToggle3d}
        >
          Anteprima 3D (facoltativa)
          <ChevronDown className={`size-3.5 transition ${show3d ? "rotate-180" : ""}`} />
        </button>
        {show3d && (
          <div className="h-48 border-t">
            <Preview3D operations={visibleOps} />
          </div>
        )}
      </div>
    </div>
  )
}
