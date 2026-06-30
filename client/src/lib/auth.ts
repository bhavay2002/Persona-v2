export function saveToken(token: string) {
  localStorage.setItem('persona_token', token);
}

export function getToken(): string | null {
  return localStorage.getItem('persona_token');
}

export function clearToken() {
  localStorage.removeItem('persona_token');
  localStorage.removeItem('persona_user');
}

export function saveUser(user: any) {
  localStorage.setItem('persona_user', JSON.stringify(user));
}

export function getUser() {
  const s = localStorage.getItem('persona_user');
  return s ? JSON.parse(s) : null;
}

export function isLoggedIn() {
  return !!localStorage.getItem('persona_token');
}
