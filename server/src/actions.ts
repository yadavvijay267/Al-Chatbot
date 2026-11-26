// Actions for the AI Chatbot.
//
// Conversations and messages live in ctx.db. Replies are generated with
// ctx.inference (the artifact's built-in model inference) from the recent
// conversation history — there is no external API key involved.

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { asc, count, desc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";

const messageShape = z.object({
  id: z.number(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  created_at: z.string(),
});

const SYSTEM_PROMPT = [
  "You are a friendly, knowledgeable AI assistant having a chat with the user.",
  "Always reply in English, even if the user writes in another language, and keep your tone friendly and natural.",
  "Be genuinely helpful: answer the actual question, explain things clearly, and ask a short follow-up only when it helps.",
  "Keep replies reasonably concise unless the user asks for detail.",
  "Format simply: short paragraphs, and simple '- ' lists when a list helps. Avoid markdown tables and heavy formatting.",
].join(" ");

const FALLBACK_REPLY =
  "Sorry, I couldn't reply just now — something hiccuped on my side. Please try sending that once more.";

function makeTitle(firstMessage: string): string {
  const clean = firstMessage.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean || "New chat";
}

export const Actions = {
  listConversations: defineAction({
    description:
      "Lists all chat conversations, most recently active first, with message counts.",
    request: z.object({}),
    response: z.object({
      conversations: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          message_count: z.number(),
          updated_at: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.conversations.id,
          title: schema.conversations.title,
          updatedAt: schema.conversations.updatedAt,
          messageCount: count(schema.messages.id),
        })
        .from(schema.conversations)
        .leftJoin(
          schema.messages,
          eq(schema.messages.conversationId, schema.conversations.id),
        )
        .groupBy(schema.conversations.id)
        .orderBy(desc(schema.conversations.updatedAt));
      return {
        conversations: rows.map((row) => ({
          id: row.id,
          title: row.title,
          message_count: row.messageCount,
          updated_at: row.updatedAt.toISOString(),
        })),
      };
    },
  }),

  getMessages: defineAction({
    description: "Returns every message of one conversation, oldest first.",
    request: z.object({ conversationId: z.number().int().positive() }),
    response: z.object({ messages: z.array(messageShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, args.conversationId))
        .orderBy(asc(schema.messages.id));
      return {
        messages: rows.map((row) => ({
          id: row.id,
          role: row.role,
          content: row.content,
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  }),

  createConversation: defineAction({
    description: "Creates a new empty chat conversation and returns its id.",
    request: z.object({}),
    response: z.object({ id: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.conversations)
        .values({ title: "New chat" })
        .returning({ id: schema.conversations.id });
      const inserted = result[0];
      if (!inserted) throw new Error("Could not create the chat.");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  sendMessage: defineAction({
    description:
      "Saves the user's message in a conversation (creating one when conversationId is null), generates the AI reply from the recent history, saves it, and returns both messages.",
    request: z.object({
      conversationId: z.number().int().positive().nullable(),
      content: z.string().trim().min(1).max(4000),
    }),
    response: z.object({
      conversationId: z.number(),
      userMessage: messageShape,
      assistantMessage: messageShape,
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const now = new Date();

      // Resolve (or create) the conversation.
      let conversationId = args.conversationId;
      if (conversationId === null) {
        const created = await db
          .insert(schema.conversations)
          .values({ title: makeTitle(args.content) })
          .returning({ id: schema.conversations.id });
        const row = created[0];
        if (!row) throw new Error("Could not create the chat.");
        conversationId = row.id;
      } else {
        const existing = await db
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, conversationId))
          .limit(1);
        if (!existing[0]) {
          throw new Error("This chat no longer exists. Please start a new chat.");
        }
      }

      // Save the user's message.
      const userInserted = await db
        .insert(schema.messages)
        .values({
          conversationId,
          role: "user",
          content: args.content,
        })
        .returning({
          id: schema.messages.id,
          createdAt: schema.messages.createdAt,
        });
      const userRow = userInserted[0];
      if (!userRow) throw new Error("Could not save your message.");

      // Build the prompt from the recent history (including the new message).
      const history = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId))
        .orderBy(desc(schema.messages.id))
        .limit(20);
      const transcript = history
        .reverse()
        .map(
          (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`,
        )
        .join("\n\n");
      const prompt = `Here is the conversation so far:\n\n${transcript}\n\nWrite the assistant's next reply to the user's last message.`;

      // Generate the reply; on any failure, save a friendly fallback so the
      // thread never dead-ends.
      let replyText = FALLBACK_REPLY;
      try {
        const result = await ctx.inference.complete(prompt, {
          system: SYSTEM_PROMPT,
          schema: z.object({ reply: z.string().min(1) }),
        });
        const trimmed = result.reply.trim();
        if (trimmed) replyText = trimmed;
      } catch {
        replyText = FALLBACK_REPLY;
      }

      const assistantInserted = await db
        .insert(schema.messages)
        .values({
          conversationId,
          role: "assistant",
          content: replyText,
        })
        .returning({
          id: schema.messages.id,
          createdAt: schema.messages.createdAt,
        });
      const assistantRow = assistantInserted[0];
      if (!assistantRow) throw new Error("Could not save the reply.");

      await db
        .update(schema.conversations)
        .set({ updatedAt: now })
        .where(eq(schema.conversations.id, conversationId));

      ctx.invalidateQueries();
      return {
        conversationId,
        userMessage: {
          id: userRow.id,
          role: "user" as const,
          content: args.content,
          created_at: userRow.createdAt.toISOString(),
        },
        assistantMessage: {
          id: assistantRow.id,
          role: "assistant" as const,
          content: replyText,
          created_at: assistantRow.createdAt.toISOString(),
        },
      };
    },
  }),

  deleteConversation: defineAction({
    description: "Deletes one conversation and all of its messages.",
    request: z.object({ conversationId: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const statements: BatchItem<"sqlite">[] = [
        db
          .delete(schema.messages)
          .where(eq(schema.messages.conversationId, args.conversationId)),
        db
          .delete(schema.conversations)
          .where(eq(schema.conversations.id, args.conversationId)),
      ];
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
