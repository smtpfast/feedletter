#!/usr/bin/env node

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk;
}

const firstTitle = prompt.match(/1\. (.+)/)?.[1] ?? "Latest update";

console.log(
  JSON.stringify(
    {
      subject: "Curated updates for builders",
      preheader: `${firstTitle} and more practical notes.`,
      intro: "A short hand-picked digest of the latest posts worth reading.",
    },
    null,
    2,
  ),
);
