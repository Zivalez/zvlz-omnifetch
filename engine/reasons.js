/* Maps machine reasons to user-facing copy. Shared by the offscreen worker and the UI. */
export const REASON_COPY = {
  checking: { line: 'Checking whether this can be saved as one complete file…', action: null },
  manifest_parse_error: { line: 'The playlist could not be read, so its completeness cannot be verified.', action: 'rescan' },
  segment_list_incomplete: { line: 'The segment list could not be fully inventoried, so it cannot be saved whole.', action: 'rescan' },
  segment_unavailable: { line: 'Some parts of this media are no longer available, so it cannot be saved whole.', action: 'retry' },
  init_missing: { line: 'The initialization segment is missing, so the result would not play.', action: 'retry' },
  key_unavailable: { line: 'The decryption key could not be fetched with your current session.', action: 'retry' },
  drm_protected: { line: 'This video is DRM-protected and cannot be downloaded.', action: 'why-drm' },
  live_stream: { line: 'This is a live stream that has not ended. You can record from now on, but not download the whole broadcast.', action: 'record' },
  auth_expired: { line: 'The media link has expired or was refused. Reload the page, play the video again, then retry.', action: 'rescan' },
  audio_incomplete: { line: 'The audio track is incomplete, so this pairing is not offered.', action: 'alt' },
  too_large: { line: 'This file is larger than the browser can safely assemble on this device.', action: 'alt' },
  codec_unsupported: { line: 'This format cannot be packaged or transcoded by the browser.', action: 'alt' },
  signature_required: { line: 'This YouTube format needs a signature the extension cannot solve yet.', action: 'rescan' },
  failed_midway: { line: 'The download stopped. Nothing partial was written to your Downloads folder.', action: 'resume' },
  session_restart: { line: 'The job was interrupted by a browser or extension restart. Start again to re-verify.', action: 'retry' },
  assembly_unverified: { line: 'The assembled file failed the integrity check, so it was not saved.', action: 'retry' },
  canceled: { line: 'Download canceled and staging cleared.', action: null },
  no_preview_source: { line: 'No streamable source for preview.', action: null },
};

export function reasonCopy(reason, vars = {}) {
  const base = REASON_COPY[reason];
  if (!base) return { line: `Not available: ${reason}`, action: null };
  let line = base.line;
  for (const [k, v] of Object.entries(vars)) line = line.replaceAll(`{${k}}`, String(v));
  return { line, action: base.action };
}

export const ACTION_LABEL = {
  rescan: 'Scan again',
  retry: 'Try again',
  record: 'Start recording',
  alt: 'See other qualities',
  resume: 'Resume',
  'why-drm': 'Why?',
};

export const DRM_WHY =
  'DRM keys (Widevine, FairPlay, PlayReady) never leave the browser\'s decryption module. The encrypted bytes can be observed, but without the license they cannot become a playable file with any tool of this kind. This item is refused up front because it is technically impossible, not because of policy.';
