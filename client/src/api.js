import axios from 'axios';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

export const WS_URL =
  process.env.REACT_APP_WS_URL ||
  API_BASE.replace(/^http(s?):\/\//, (match, secure) => `ws${secure}://`).replace(/\/api\/?$/, '');

export const login = async (credentials) => {
  const { data } = await axios.post(`${API_BASE}/auth/login`, credentials);
  return data.token;
};

export const getCurrentUser = async (token) => {
  const { data } = await axios.get(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data;
};

export default API_BASE;
