import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import { api, type ApiResponse } from "./api";
import type { Actions } from "../../server/src/actions";

const FIELDS = actionFields<typeof Actions>();

type Conversation =
  ApiResponse<typeof api, "listConversations">["conversations"][number];
type ChatMessage =
  ApiResponse<typeof api, "getMessages">["messages"][number];

const STARTERS = [
  "Tell me a short, funny story",
  "Explain photosynthesis like I'm 10 years old",
  "Give me 5 ideas for a healthy breakfast",
  "Write a short poem about the rain",
  "Quiz me with 3 questions about space",
  "Help me write a birthday wish for my friend",
];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return formatTime(iso);
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** Renders **bold** inline and groups "- " lines into a simple list. */
function RichText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        const isList = lines.every(
          (l) => l.trim().startsWith("- ") || l.trim().startsWith("• "),
        );
        if (isList && lines.length > 1) {
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {lines.map((l, li) => (
                <li key={li}>{renderInline(l.trim().replace(/^[-•]\s*/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi} className="whitespace-pre-wrap">
            {lines.map((l, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {renderInline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function TypingBubble() {
  return (
    <div className="flex items-end gap-2">
      <div
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] font-display text-sm font-semibold text-white"
      >
        A
      </div>
      <div
        role="status"
        aria-label="AI is typing"
        className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
      >
        <span className="typing-dot h-2 w-2 rounded-full bg-[var(--dim)]" />
        <span className="typing-dot h-2 w-2 rounded-full bg-[var(--dim)]" />
        <span className="typing-dot h-2 w-2 rounded-full bg-[var(--dim)]" />
      </div>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.listConversations({}),
  });

  const messages = useQuery({
    queryKey: ["messages", selectedId],
    queryFn: () =>
      selectedId != null
        ? api.getMessages({ conversationId: selectedId })
        : Promise.resolve({ messages: [] as ChatMessage[] }),
  });

  const send = useMutation({
    mutationFn: async (content: string) =>
      await api.sendMessage({ conversationId: selectedId, content }),
    onSuccess: (data) => {
      setSelectedId(data.conversationId);
      setPendingText(null);
      setSendError(null);
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({
        queryKey: ["messages", data.conversationId],
      });
    },
    onError: (error) => {
      setPendingText(null);
      setSendError(
        error instanceof Error
          ? error.message
          : "Your message could not be sent. Please try again.",
      );
    },
  });

  const remove = useMutation({
    mutationFn: async (id: number) =>
      await api.deleteConversation({ conversationId: id }),
    onSuccess: (_data, id) => {
      setConfirmDeleteId(null);
      if (selectedId === id) setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (error) => {
      setSendError(
        error instanceof Error
          ? error.message
          : "That chat could not be deleted. Please try again.",
      );
    },
  });

  const messageList = messages.data?.messages ?? [];
  const isSending = send.isPending;

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageList.length, pendingText, isSending, selectedId]);

  // Auto-grow the composer.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const currentTitle =
    conversations.data?.conversations.find((c) => c.id === selectedId)?.title ??
    "New chat";

  function startNewChat() {
    setSelectedId(null);
    setDraft("");
    setSendError(null);
    setSidebarOpen(false);
    textareaRef.current?.focus();
  }

  function handleSend(content: string) {
    const text = content.trim();
    if (!text || isSending) return;
    setSendError(null);
    setPendingText(text);
    setDraft("");
    send.mutate(text);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    handleSend(draft);
  }

  const showEmptyState = selectedId === null && messageList.length === 0 && !pendingText;

  const sidebar = (
    <div className="flex h-full flex-col bg-[var(--sand)]">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <h2 className="font-display text-lg font-semibold">Your chats</h2>
        <button
          type="button"
          onClick={startNewChat}
          aria-label="Start a new chat"
          className="flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          New
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {conversations.isPending ? (
          <p className="px-3 py-4 text-sm text-[var(--dim)]">Loading chats…</p>
        ) : conversations.isError ? (
          <p className="px-3 py-4 text-sm text-[var(--dim)]">
            Chats could not be loaded.{" "}
            <button
              type="button"
              className="font-medium text-[var(--accent)] underline"
              onClick={() => void conversations.refetch()}
            >
              Try again
            </button>
          </p>
        ) : (conversations.data?.conversations.length ?? 0) === 0 ? (
          <p className="px-3 py-4 text-sm text-[var(--dim)]">
            No chats yet. Start a new one and say hello.
          </p>
        ) : (
          <ul className="space-y-1">
            {conversations.data?.conversations.map((c: Conversation) => {
              const active = c.id === selectedId;
              const confirming = confirmDeleteId === c.id;
              return (
                <li key={c.id}>
                  <div
                    className={`group flex items-center gap-1 rounded-xl px-3 py-2.5 ${
                      active
                        ? "bg-[var(--surface)] shadow-sm"
                        : "hover:bg-[var(--surface)]/60"
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      aria-label={`Open chat: ${c.title}`}
                      onClick={() => {
                        setSelectedId(c.id);
                        setSidebarOpen(false);
                        setSendError(null);
                      }}
                    >
                      <span className="block truncate text-sm font-medium">
                        {c.title}
                      </span>
                      <span className="block text-xs text-[var(--dim)]">
                        {c.message_count}{" "}
                        {c.message_count === 1 ? "message" : "messages"} ·{" "}
                        {formatDay(c.updated_at)}
                      </span>
                    </button>
                    {confirming ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Confirm delete chat: ${c.title}`}
                          className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-semibold text-white"
                          onClick={() => remove.mutate(c.id)}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel delete"
                          className="rounded-full px-2 py-1 text-xs font-medium text-[var(--dim)]"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete chat: ${c.title}`}
                        className="shrink-0 rounded-full p-2 text-[var(--dim)] hover:text-red-600"
                        onClick={() => setConfirmDeleteId(c.id)}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6" />
                        </svg>
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 pb-2.5 pt-safe">
        <button
          type="button"
          aria-label="Open chats list"
          className="rounded-full p-2 text-[var(--dim)] md:hidden"
          onClick={() => setSidebarOpen(true)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] font-display text-base font-semibold text-white"
          >
            A
          </div>
          <div className="min-w-0">
            <p className="truncate font-display text-base font-semibold leading-tight">
              {selectedId === null ? "AI Friend" : currentTitle}
            </p>
            <p className="text-xs leading-tight text-[var(--dim)]">
              {isSending ? "Typing…" : "Your AI chat companion"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={startNewChat}
          aria-label="Start a new chat"
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-sm font-medium"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar: static on desktop */}
        <aside className="hidden w-72 shrink-0 border-r border-[var(--border)] md:block">
          {sidebar}
        </aside>

        {/* Sidebar: drawer on phone */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <button
              type="button"
              aria-label="Close chats list"
              className="absolute inset-0 bg-black/40"
              onClick={() => setSidebarOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 w-80 max-w-[85vw] shadow-xl">
              {sidebar}
            </div>
          </div>
        )}

        {/* Chat column */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5">
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
              {showEmptyState ? (
                <div className="pt-8 text-center">
                  <div
                    aria-hidden
                    className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[var(--accent)] font-display text-3xl font-semibold text-white"
                  >
                    A
                  </div>
                  <h1 className="mt-4 font-display text-3xl font-semibold">
                    Hello! I'm your AI Friend
                  </h1>
                  <p className="mx-auto mt-2 max-w-md text-[var(--dim)]">
                    Ask me anything — a question, a story, help with writing,
                    or just a friendly chat. I always reply in clear, friendly
                    English.
                  </p>
                  <div className="mx-auto mt-7 grid max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
                    {STARTERS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-sm font-medium shadow-sm transition-colors hover:border-[var(--accent)]"
                        onClick={() => handleSend(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {messages.isPending && selectedId !== null ? (
                    <p className="py-8 text-center text-sm text-[var(--dim)]">
                      Loading this chat…
                    </p>
                  ) : messages.isError ? (
                    <p className="py-8 text-center text-sm text-[var(--dim)]">
                      This chat could not be loaded.{" "}
                      <button
                        type="button"
                        className="font-medium text-[var(--accent)] underline"
                        onClick={() => void messages.refetch()}
                      >
                        Try again
                      </button>
                    </p>
                  ) : (
                    messageList.map((m) =>
                      m.role === "user" ? (
                        <div key={m.id} className="flex justify-end">
                          <div className="max-w-[85%] sm:max-w-[75%]">
                            <div className="rounded-2xl rounded-br-md bg-[var(--accent)] px-4 py-2.5 text-[15px] leading-relaxed text-white">
                              <p className="whitespace-pre-wrap">{m.content}</p>
                            </div>
                            <p className="mt-1 text-right text-[11px] text-[var(--dim)]">
                              {formatTime(m.created_at)}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div key={m.id} className="flex items-end gap-2">
                          <div
                            aria-hidden
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] font-display text-sm font-semibold text-white"
                          >
                            A
                          </div>
                          <div className="max-w-[85%] sm:max-w-[75%]">
                            <div className="rounded-2xl rounded-bl-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-[15px] leading-relaxed shadow-sm">
                              <RichText text={m.content} />
                            </div>
                            <p className="mt-1 text-[11px] text-[var(--dim)]">
                              {formatTime(m.created_at)}
                            </p>
                          </div>
                        </div>
                      ),
                    )
                  )}

                  {pendingText !== null && (
                    <div className="flex justify-end">
                      <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-md bg-[var(--accent)] px-4 py-2.5 text-[15px] leading-relaxed text-white opacity-80">
                        <p className="whitespace-pre-wrap">{pendingText}</p>
                      </div>
                    </div>
                  )}
                  {isSending && <TypingBubble />}
                </>
              )}
            </div>
          </div>

          {/* Composer */}
          <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-3 pb-safe pt-2.5">
            <div className="mx-auto w-full max-w-2xl">
              {sendError && (
                <p role="alert" className="mb-2 text-sm text-red-600">
                  {sendError}
                </p>
              )}
              <form onSubmit={onSubmit} className="flex items-end gap-2">
                <label htmlFor="chat-message" className="sr-only">
                  Message
                </label>
                <textarea
                  id="chat-message"
                  ref={textareaRef}
                  {...FIELDS.sendMessage.content}
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend(draft);
                    }
                  }}
                  placeholder="Type your message…"
                  className="max-h-[132px] flex-1 resize-none rounded-2xl border border-[var(--border)] bg-[var(--bg)] px-4 py-2.5 text-base outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  disabled={!draft.trim() || isSending}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-opacity disabled:opacity-40"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </form>
              <p className="mt-1.5 text-center text-[11px] text-[var(--dim)]">
                Enter sends · Shift + Enter for a new line
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
