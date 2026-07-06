import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { askAnalyst } from "../intent/analyst.server";
import { renderMarkdown } from "../lib/markdown";
import { AssistantChart, type ChartSpec } from "../components/charts";

import { getBackofficeMeta } from "../intent/settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const backoffice = await getBackofficeMeta(session.shop);
  return { botEnabled: backoffice.botEnabled !== false };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const question = String(form.get("question") || "");
  const history = JSON.parse(String(form.get("history") || "[]"));
  
  const backoffice = await getBackofficeMeta(session.shop);
  if (backoffice.botEnabled === false) {
    return { answer: "Your store has been banned/disabled. Analytics assistant is unavailable." };
  }

  if (!question.trim()) return { answer: "" };
  try {
    return await askAnalyst(session.shop, question, history);
  } catch (err) {
    console.error("analyst failed", err);
    return { answer: "Sorry — I couldn't analyze that just now. Please try again." };
  }
};

type Msg = { role: "user" | "assistant"; content: string; chart?: ChartSpec };

const STARTERS = [
  "Which shopper cohort converts best?",
  "Where are shoppers dropping off?",
  "What are people searching for most?",
  "What price ceilings do shoppers show?",
];

export default function Assistant() {
  const { botEnabled } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const busy = fetcher.state !== "idle";

  // Append the assistant answer when it arrives.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.answer) {
      setMessages((m) =>
        m.some((x) => x.role === "assistant" && x.content === fetcher.data!.answer)
          ? m
          : [...m, { role: "assistant", content: fetcher.data!.answer, chart: fetcher.data!.chart }],
      );
    }
  }, [fetcher.state, fetcher.data]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  function ask(question: string) {
    if (!question.trim() || busy) return;
    const history = messages.slice(-8);
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");
    fetcher.submit({ question, history: JSON.stringify(history) }, { method: "POST" });
  }

  return (
    <s-page heading="Analytics assistant">
      <s-section heading="Ask about your shoppers' intent">
        <s-paragraph>
          <s-text tone="neutral">Ask in plain language — answers are grounded in this store's live intent data.</s-text>
        </s-paragraph>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <div style={{ minHeight: 280, maxHeight: 440, overflowY: "auto", padding: 4 }}>
            {messages.length === 0 && (
              <div style={{ color: "#6d7175", fontSize: 13, padding: 8 }}>
                Try one of the suggestions below, or type your own question.
              </div>
            )}
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
                  <div style={{ maxWidth: "78%", padding: "10px 14px", borderRadius: "14px 14px 4px 14px", background: "#202223", color: "#fff", fontSize: 13.5, lineHeight: 1.5 }}>
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div
                    style={{ maxWidth: "96%", padding: "10px 14px", borderRadius: "14px 14px 14px 4px", background: "#fff", color: "#1f2937", border: "1px solid #e3e5e8", fontSize: 13.5, lineHeight: 1.5 }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                  />
                  {m.chart && <AssistantChart spec={m.chart} />}
                </div>
              ),
            )}
            {busy && <div style={{ color: "#6d7175", fontSize: 13, padding: 8 }}>Analyzing…</div>}
            <div ref={endRef} />
          </div>
        </s-box>

        <s-stack direction="inline" gap="small">
          {STARTERS.map((q) => (
            <s-button key={q} variant="tertiary" onClick={() => ask(q)}>{q}</s-button>
          ))}
        </s-stack>

        <form
          onSubmit={(e) => { e.preventDefault(); ask(input); }}
          style={{ display: "flex", gap: 8, marginTop: 12 }}
        >
          <input
            value={input}
            disabled={!botEnabled}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. Which cohort should I target with a promo?"
            style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: "1px solid #c9cccf", fontSize: 14, outline: "none", opacity: botEnabled ? 1 : 0.5 }}
          />
          <s-button variant="primary" disabled={!botEnabled} onClick={() => ask(input)} {...(busy ? { loading: true } : {})}>Ask</s-button>
        </form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
