"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { COMPLIANCE_QUIZ } from "@retenix/shared";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  getGateRegion,
  getQuizAnswers,
  setQuizAnswer,
} from "@/lib/gate";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const REGION = "/eligibility/region";
const IDENTITY = "/eligibility/identity";

export function QuizStep({ step }: { step: number }) {
  const router = useRouter();
  const question = COMPLIANCE_QUIZ[step - 1];
  const total = COMPLIANCE_QUIZ.length;
  const isLast = step === total;

  const [selected, setSelected] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);

  const submitQuiz = trpc.compliance.submitQuiz.useMutation({
    onSuccess: () => router.push(IDENTITY),
    // Server refused (e.g. no region on record) — send them back to the start.
    onError: () => router.replace(REGION),
  });

  // Order guard: a region must be picked, and earlier questions answered, before
  // this one renders. The server is the authoritative guard (finalization), this
  // just keeps the UI honest for a mid-gate deep link. Prefetch the next screen.
  useEffect(() => {
    if (!getGateRegion()) {
      router.replace(REGION);
      return;
    }
    if (step > 1 && getQuizAnswers().slice(0, step - 1).some((a) => a === null)) {
      router.replace(REGION);
      return;
    }
    router.prefetch(isLast ? IDENTITY : `/eligibility/quiz/${step + 1}`);
  }, [router, step, isLast]);

  function handleSelect(value: string) {
    if (submitQuiz.isPending) return;
    setSelected(value);
    const index = Number(value);

    if (!question.options[index]?.correct) {
      setWrong(true); // teaching, not failing — amber, retry allowed
      return;
    }

    setWrong(false);
    setQuizAnswer(step, index);

    if (isLast) {
      const answers = getQuizAnswers().map((a) => a ?? 0);
      submitQuiz.mutate({ answers });
    } else {
      router.push(`/eligibility/quiz/${step + 1}`);
    }
  }

  return (
    <section
      className="flex min-h-[80dvh] flex-col justify-center gap-8 py-12"
      aria-labelledby="quiz-heading"
    >
      <header className="space-y-3">
        <p className="text-caption text-muted-foreground">
          Question {step} of {total}
        </p>
        <h1 id="quiz-heading" className="font-display text-h1 leading-tight">
          {question.prompt}
        </h1>
      </header>

      <RadioGroup
        value={selected ?? undefined}
        onValueChange={handleSelect}
        aria-label={question.prompt}
        className="gap-3"
      >
        {question.options.map((option, index) => {
          const value = String(index);
          const isChosen = selected === value;
          const labelId = `opt-label-${index}`;
          // The <label> wraps the radio, so a click anywhere on the card forwards
          // to it (a <button> is a labelable element) — the whole card is one tap.
          return (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-micro",
                isChosen ? "border-primary" : "border-border hover:bg-accent",
              )}
            >
              <RadioGroupItem
                value={value}
                id={`opt-${index}`}
                aria-labelledby={labelId}
                className="mt-0.5"
              />
              <span id={labelId} className="text-body">
                {option.text}
              </span>
            </label>
          );
        })}
      </RadioGroup>

      {wrong && (
        <p role="status" className="text-small text-warning">
          {question.explanation}
        </p>
      )}
    </section>
  );
}
