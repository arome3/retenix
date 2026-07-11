/*
 * In-flight eligibility-gate state (doc 04), carried across the one-route-per-step
 * screens (region → quiz/1..3 → identity → risk).
 *
 * sessionStorage, never the URL. This is a UX convenience only — the server is
 * authoritative (the region_set / quiz_passed / risk events, re-checked at
 * finalization), so losing this (a new tab, private mode) degrades the flow to
 * "start the gate over," it never lets the gate be skipped. Every access is
 * defensive: private-mode browsers throw on storage.
 */
import { COMPLIANCE_QUIZ } from "@retenix/shared";

const REGION_KEY = "retenix:gate:region";
const QUIZ_KEY = "retenix:gate:quiz";

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the flow still works, it just cannot resume.
  }
}

function remove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear if storage is unreachable.
  }
}

/** The region the user picked this session (ISO alpha-2), or null. */
export function getGateRegion(): string | null {
  return read(REGION_KEY);
}

export function setGateRegion(code: string): void {
  write(REGION_KEY, code);
}

/** Selected option index per question; null where not yet answered. */
export function getQuizAnswers(): (number | null)[] {
  const empty = COMPLIANCE_QUIZ.map(() => null as number | null);
  const raw = read(QUIZ_KEY);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return empty;
    return COMPLIANCE_QUIZ.map((_, i) =>
      typeof parsed[i] === "number" ? (parsed[i] as number) : null,
    );
  } catch {
    return empty;
  }
}

/** Record the answer to a question (1-indexed to match the /quiz/[step] route). */
export function setQuizAnswer(step: number, choice: number): void {
  const answers = getQuizAnswers();
  if (step < 1 || step > answers.length) return;
  answers[step - 1] = choice;
  write(QUIZ_KEY, JSON.stringify(answers));
}

/** True once every question has a recorded answer. */
export function quizComplete(): boolean {
  return getQuizAnswers().every((a) => a !== null);
}

export function clearGate(): void {
  remove(REGION_KEY);
  remove(QUIZ_KEY);
}
