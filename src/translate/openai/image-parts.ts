// ==============================================================================
// Image content-part helpers (Responses -> OpenAI Chat)
// ==============================================================================
//
// Shared by user-message and tool-output translation so both map images
// identically. Extracted from translateRequest to keep that module focused.

export function isImagePart(part: { type?: string }): boolean {
  return part.type === 'input_image' || part.type === 'image' || part.type === 'image_url';
}

/** Extract a chat `image_url` value (http(s) URL or data: URI) from a Responses
 *  image part. */
export function imagePartToUrl(part: {
  image_url?: string | { url?: string };
  data?: string;
  base64?: string;
  mime_type?: string;
  media_type?: string;
}): string {
  const imgUrl = part.image_url;
  if (typeof imgUrl === 'string') {
    return imgUrl;
  }
  if (imgUrl && typeof imgUrl === 'object' && imgUrl.url) {
    return imgUrl.url;
  }
  const imgData = String(part.data ?? part.base64 ?? '');
  if (imgData) {
    const mimeType = String(part.mime_type ?? part.media_type ?? 'image/png');
    return imgData.startsWith('data:') ? imgData : `data:${mimeType};base64,${imgData}`;
  }
  return '';
}
