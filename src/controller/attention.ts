/**
 * Ambient listening.
 *
 * A room that has just been spoken to keeps listening for a while, so a
 * conversation does not have to be punctuated with mentions. Whether an
 * un-mentioned message is actually meant for the bot is a question about
 * conversational context - precisely what a keyword rule gets wrong - so it is
 * handed to the runtime, wrapped in a check that lets the runtime decline.
 *
 * The wrapper lives here rather than in the instruction registry on purpose.
 * The registry is the persona, and a persona should not be able to talk the bot
 * out of keeping quiet.
 */

/** The reply meaning "this was not addressed to me". Never shown to anyone. */
export const NOT_FOR_ME = "__NOT_FOR_ME__";

/** Wraps an un-mentioned message so the runtime can decline to answer it. */
export function ambientPreamble(text: string): string {
  return [
    "<addressed-to-me-check>",
    "The message below was posted in the channel without addressing you directly.",
    "You are being shown it because someone spoke to you a moment ago and you are",
    "still listening.",
    "",
    "Decide whether it is meant for you: a follow-up to what you were just",
    "discussing, a question you are being asked, or a reply to something you said.",
    "People talking among themselves is not meant for you, and neither is a message",
    "that merely mentions the subject you were working on.",
    "",
    `If it is not meant for you, reply with exactly ${NOT_FOR_ME} and nothing else.`,
    "That reply is discarded and nobody sees it, so being wrong in that direction",
    "costs nothing. If it is meant for you, answer it normally and never mention",
    "this check.",
    "</addressed-to-me-check>",
    "",
    text,
  ].join("\n");
}

/**
 * True when a reply is the runtime declining to answer.
 *
 * Deliberately tolerant of a model that adds punctuation or a code fence around
 * the sentinel: a decline that is not recognised gets posted to the channel as
 * gibberish, which is the worst outcome available.
 */
export function isDecline(text: string): boolean {
  const stripped = text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/[`*_~"'.!]/g, "")
    .trim();
  return stripped === NOT_FOR_ME || stripped === NOT_FOR_ME.replace(/_/g, "");
}
