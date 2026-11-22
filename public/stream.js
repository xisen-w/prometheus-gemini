// One way to follow a run's events, for both pages. Opened on this machine it is an event stream. Through a
// tunnel or the sharednet.ai forward it is one request after another, each answered as soon as there is
// something new: a tunnel holds a slow stream back until a buffer fills, so a small run looked stuck.
export const POLLED = !!window.GP?.forwarded || /(^|\.)trycloudflare\.com$/.test(location.hostname);

export function follow(base, id, { onEvent, onError }) {
  const at = `${base}/api/runs/${encodeURIComponent(id)}`;
  if (!POLLED) {
    // every event has an id, so after a dropped connection the browser asks the server to resume, not replay
    const es = new EventSource(`${at}/stream`);
    es.onmessage = (e) => { let ev; try { ev = JSON.parse(e.data); } catch { return; } onEvent(ev); };
    es.onerror = () => onError?.();
    return { close: () => es.close() };
  }
  let closed = false;
  (async () => {
    let from = 0;
    while (!closed) {
      let text;
      try {
        const r = await fetch(`${at}/events?from=${from}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        text = await r.text();
      } catch {
        onError?.();
        await new Promise((ok) => setTimeout(ok, 3000));
        continue;
      }
      const cut = text.indexOf('\n');
      let next = from;
      try { next = Number(JSON.parse(text.slice(0, cut < 0 ? text.length : cut)).next) || from; } catch {}
      for (const line of cut < 0 ? [] : text.slice(cut + 1).split('\n')) {
        if (closed) return;
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        onEvent(ev);
      }
      from = next;
    }
  })();
  return { close: () => { closed = true; } };
}
