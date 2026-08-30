import { storage } from "./firebase.js";
import { ref, uploadString, uploadBytes, getDownloadURL } from "firebase/storage";

/**
 * Uploads a base64 data URL to Firebase Storage and returns a fetchable URL.
 * The URL is small and can be safely saved to Firestore for real-time sync.
 */
export async function uploadImageToStorage(
  boardId: string,
  boxId: string,
  dataUrl: string
): Promise<string> {
  const imageRef = ref(storage, "boards/" + boardId + "/images/" + boxId + ".jpg");
  await uploadString(imageRef, dataUrl, "data_url");
  return await getDownloadURL(imageRef);
}

/**
 * Uploads a document file (PDF/DOCX/TXT/…) to the board's documents path and
 * returns a fetchable URL. Best-effort by design: the Documents box keeps the
 * extracted text in boxData even when this fails (signed-out local mode,
 * permission errors) — the URL is only for re-downloading the original file.
 */
export async function uploadDocumentToStorage(
  boardId: string,
  boxId: string,
  file: File
): Promise<string> {
  // Storage paths must be filesystem-safe — keep the name conservative.
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const docRef = ref(
    storage,
    `boards/${boardId}/documents/${boxId}/${Date.now()}-${safeName}`
  );
  await uploadBytes(docRef, file, {
    contentType: file.type || "application/octet-stream",
  });
  return await getDownloadURL(docRef);
}