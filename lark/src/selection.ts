function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function selectRecordingDevices(value: unknown): {
  inputId: string; collectionId: string; microphoneId: string;
} | null {
  const request = record(value);
  if (!request || !Array.isArray(request.inputs) || request.inputs.length !== 1
    || !Array.isArray(request.microphones) || request.microphones.length > 64) return null;
  const input = record(request.inputs[0]);
  if (!input || typeof input.inputId !== "string" || !input.inputId
    || input.collectionId !== "Col01") return null;
  const microphones = request.microphones.map(record).filter((microphone) => microphone
    && typeof microphone.deviceId === "string" && microphone.deviceId
    && microphone.deviceId !== "default" && microphone.deviceId !== "communications"
    && typeof microphone.label === "string" && /\bwireless microphone\b/i.test(microphone.label));
  if (microphones.length !== 1) return null;
  return { inputId: input.inputId, collectionId: input.collectionId,
    microphoneId: microphones[0]!.deviceId as string };
}
