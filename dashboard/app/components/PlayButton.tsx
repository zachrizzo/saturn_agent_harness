"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui";

type PlayButtonProps = {
  jobName: string;
};

export function PlayButton({ jobName }: PlayButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleRun = async () => {
    setIsLoading(true);

    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobName)}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to trigger job");
      }

      router.push(`/jobs/${jobName}`);
    } catch (err) {
      console.error(err);
      setIsLoading(false);
    }
  };

  return (
    <Button
      variant="primary"
      size="icon"
      onClick={handleRun}
      disabled={isLoading}
      title="Run job now"
      aria-label="Run job now"
    >
      {isLoading ? (
        <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
        </svg>
      )}
    </Button>
  );
}
