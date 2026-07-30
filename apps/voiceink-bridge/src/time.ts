import * as DateTime from "effect/DateTime";

export const nowIso = (): string => DateTime.formatIso(DateTime.nowUnsafe());
export const nowEpochMillis = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());
