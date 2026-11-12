import { useState } from "react";
import { Activity, ChevronDown, ChevronRight, Download, Play } from "lucide-react";
import { OBSERVATORY_TESTS, type TestResult, type TestStatus } from "@relaymesh/observatory";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Card, PageHeader, cx, download, type Tone } from "../ui/kit.tsx";

const tone: Record<TestStatus, Tone> = { PASS: "good", FAIL: "bad", LIMITED: "warn", "NOT TESTED": "neutral" };
const CATS = ["privacy", "security", "availability", "integrity"] as const;

function ResultRow({ id }: { id: string }) {
  const rt = useRuntime();
  const test = OBSERVATORY_TESTS.find((t) => t.id === id)!;
  const r: TestResult | undefined = rt.observatory.find((x) => x.id === id);
  const [open, setOpen] = useState(false);
  return (
    <li className="px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-ink-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-ink-400" />}
          <span className="font-mono text-[11px] text-ink-400">{test.id}</span>
          <span className="truncate text-sm text-ink-100">{test.title}</span>
        </button>
        {r ? <Badge tone={tone[r.status]}>{r.status}</Badge> : <Badge>not run</Badge>}
        <Button size="sm" variant="ghost" disabled={rt.observatoryRunning} onClick={() => void rt.runObservatory(test.id)} aria-label={`Run ${test.title}`}>
          <Play className="h-3.5 w-3.5" />
        </Button>
      </div>
      {open && (
        <div className="mt-3 grid gap-4 pl-6 text-xs lg:grid-cols-2">
          <div className="space-y-3">
            <div>
              <div className="mb-1 font-medium text-ink-300">What is tested and how</div>
              <p className="leading-relaxed text-ink-200">{test.method}</p>
            </div>
            <div>
              <div className="mb-1 font-medium text-ink-300">Limitations</div>
              <ul className="list-disc space-y-1 pl-4 leading-relaxed text-ink-300">
                {(r?.limitations ?? test.limitations).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          </div>
          <div>
            <div className="mb-1 font-medium text-ink-300">Evidence</div>
            {r ? (
              <>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-200 scroll-thin">{r.evidence.join("\n")}</pre>
                <div className="mt-1.5 text-[11px] text-ink-400">
                  {new Date(r.finishedAt).toLocaleString()} · {r.durationMs} ms · test v{r.version}
                </div>
              </>
            ) : (
              <p className="text-ink-400">Run the test to collect evidence.</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function Observatory() {
  const rt = useRuntime();
  const counts = rt.observatory.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  return (
    <>
      <PageHeader
        title="Privacy Observatory"
        subtitle="Real tests that run in this browser against your actual configuration. Each result shows how it was tested, the evidence collected, and what it does not prove. There is no overall score: privacy is not a single number."
        actions={
          <>
            <Button size="sm" variant="ghost" disabled={rt.observatory.length === 0} onClick={() => download(`relaymesh-observatory-${Date.now()}.json`, JSON.stringify(rt.observatory, null, 2))}>
              <Download className="h-3.5 w-3.5" /> Export report
            </Button>
            <Button size="sm" variant="primary" loading={rt.observatoryRunning} onClick={() => void rt.runObservatory()}>
              <Activity className="h-3.5 w-3.5" /> Run all tests
            </Button>
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {(["PASS", "FAIL", "LIMITED", "NOT TESTED"] as const).map((s) => (
          <div key={s} className={cx("rounded-lg border bg-ink-850 px-4 py-3", s === "FAIL" && counts[s] ? "border-rose/40" : "border-ink-700")}>
            <div className="font-mono text-2xl text-ink-100">{counts[s] ?? 0}</div>
            <div className="mt-0.5">
              <Badge tone={tone[s]}>{s}</Badge>
            </div>
          </div>
        ))}
      </div>
      <div className="mb-4">
        <Callout>
          A passing encryption test does not mean your metadata is private, and a passing storage test does not mean your device is uncompromised. Some tests publish a gift-wrapped note to
          yourself on your relays to inspect what the operator stores.
        </Callout>
      </div>
      <div className="space-y-4">
        {CATS.map((c) => (
          <Card key={c}>
            <div className="border-b border-ink-700 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-ink-400">{c}</div>
            <ul className="divide-y divide-ink-700">
              {OBSERVATORY_TESTS.filter((t) => t.category === c).map((t) => (
                <ResultRow key={t.id} id={t.id} />
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
