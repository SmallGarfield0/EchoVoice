export type FileSavePicker = (options: {
  suggestedName: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<{
  createWritable(): Promise<FileSaveWritable>;
}>;

type FileSaveWritable = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
};

type FileSaveWindow = Window & { showSaveFilePicker?: FileSavePicker };

export function systemFileSaveAvailable(): boolean {
  return typeof (window as FileSaveWindow).showSaveFilePicker === "function";
}

export async function saveFileWithSystemPicker(
  loadBlob: () => Promise<Blob>,
  suggestedName: string,
  mimeType: string,
  picker: FileSavePicker | undefined = (window as FileSaveWindow).showSaveFilePicker
): Promise<"saved" | "cancelled"> {
  if (!picker) throw new Error("system file save picker is unavailable");
  let writable: FileSaveWritable | null = null;
  try {
    const extensions = fileExtensionList(suggestedName);
    const handle = await picker({
      suggestedName,
      ...(mimeType && extensions.length > 0 ? {
        types: [{
          description: mimeType,
          accept: { [mimeType]: extensions }
        }]
      } : {})
    });
    const blob = await loadBlob();
    writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    writable = null;
    return "saved";
  } catch (caught) {
    if (writable?.abort) await writable.abort().catch(() => undefined);
    if (caught instanceof DOMException && caught.name === "AbortError") return "cancelled";
    if (caught instanceof Error && caught.name === "AbortError") return "cancelled";
    throw caught;
  }
}

function fileExtensionList(name: string): string[] {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return [];
  return [name.slice(index).toLowerCase()];
}
