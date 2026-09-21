import { sections, type CommentThread } from "@quire/bridge";

export function threadPrompt(text: string, thread: CommentThread): string {
  const document = text.length <= 24000 ? text : `${text.slice(0, 8000)}\n\n[Document truncated; use quire_read_artifact for the rest.]\nOutline (committed offsets, up to 200 headings): ${JSON.stringify(sections(text).slice(0, 200)).slice(0, 12000)}`;
  return `Current committed document (${text.length} characters):\n<document>\n${document}\n</document>\nActive comment and thread history (range uses full CRDT offsets; find the quote in committed text):\n${JSON.stringify(thread)}\nRespond to the latest human request on this thread.`;
}
