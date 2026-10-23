import { useEffect, useState } from "react";
import { Greeter, events, type SystemInfo } from "./mygo";

export default function App() {
  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState("");
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [clock, setClock] = useState("--:--:--");

  useEffect(() => {
    let cancelled = false;
    Greeter.info().then((result) => {
      if (!cancelled) setInfo(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => events.tick.on((time) => {
    setClock(new Date(time).toLocaleTimeString());
  }), []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setGreeting(await Greeter.greet(name));
  }

  return (
    <main className="mx-auto grid min-h-screen w-full max-w-xl place-items-center bg-background px-6 text-foreground">
      <div className="w-full text-center">
        <h1 className="text-4xl font-semibold tracking-tight">linkdeck</h1>
        <p className="mt-2 text-muted-foreground">
          Go ↔ TypeScript, fully typed.
        </p>

        <form onSubmit={onSubmit} className="mt-8 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="off"
            autoFocus
            className="min-h-11 flex-1 rounded-[var(--radius)] border border-input bg-card px-3.5 py-2.5 text-foreground placeholder:text-muted-foreground focus:outline-2 focus:outline-ring"
          />
          <button
            type="submit"
            className="min-h-11 rounded-[var(--radius)] bg-primary px-5 py-2.5 font-medium text-primary-foreground hover:opacity-90"
          >
            Greet
          </button>
        </form>

        {greeting && (
          <p className="mt-4 rounded-[var(--radius)] border border-border bg-card p-4">
            {greeting}
          </p>
        )}

        <p className="mt-6 font-mono text-sm text-muted-foreground">
          {info ? `${info.os}/${info.arch} · ${info.goVersion}` : "…"} · {clock}
        </p>
      </div>
    </main>
  );
}
