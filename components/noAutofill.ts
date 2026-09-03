/**
 * Stop password managers autofilling SERVICE-credential forms.
 *
 * Bitwarden (and 1Password/LastPass/Dashlane) treat "a text input near a
 * password input" as a login form, so the Connections page gets a saved
 * username pasted into a Plex hostname and a personal password into a Tautulli
 * API key. Spread this onto EVERY input on such a form, not only the secret
 * ones - the plain text fields are what make it look like a login in the first
 * place. Each manager needs its own opt-out; `autoComplete="off"` alone is
 * widely ignored by Chromium.
 */
export const noAutofill: Record<string, string> = {
  autoComplete: 'off',
  'data-bwignore': 'true', // Bitwarden
  'data-1p-ignore': 'true', // 1Password
  'data-lpignore': 'true', // LastPass
  'data-form-type': 'other', // Dashlane
};

/**
 * For secret inputs: `new-password` additionally suppresses the saved-credential
 * dropdown that `off` does not reliably stop.
 */
export const noAutofillSecret: Record<string, string> = {
  ...noAutofill,
  autoComplete: 'new-password',
};
