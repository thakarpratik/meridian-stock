import { createServerFn } from "@tanstack/react-start";

import { getDayBook, getDesk } from "./build";

export { fetchIntraday, getDayBook, getDesk } from "./build";

export const loadDesk = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const force =
      typeof input === "object" &&
      input !== null &&
      "force" in input &&
      (input as { force?: unknown }).force === true;
    return { force };
  })
  .handler(async ({ data }) => getDesk(data.force));

export const loadDay = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const force =
      typeof input === "object" &&
      input !== null &&
      "force" in input &&
      (input as { force?: unknown }).force === true;
    return { force };
  })
  .handler(async ({ data }) => getDayBook(data.force));
