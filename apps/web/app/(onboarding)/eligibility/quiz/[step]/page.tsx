import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { COMPLIANCE_QUIZ } from "@retenix/shared";
import { QuizStep } from "./QuizStep";

export const metadata: Metadata = { title: "A quick check" };

// C12 step 2 (doc 04): one question per screen (DS-C12 + WCAG — reduces cognitive
// load). Routes are /eligibility/quiz/1..3. `key` forces a fresh component per
// step so state never carries between questions.
export default async function QuizPage({
  params,
}: {
  params: Promise<{ step: string }>;
}) {
  const { step } = await params;
  const n = Number(step);
  if (!Number.isInteger(n) || n < 1 || n > COMPLIANCE_QUIZ.length) notFound();
  return <QuizStep key={n} step={n} />;
}
