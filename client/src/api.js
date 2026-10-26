import axios from 'axios';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

export const WS_URL =
  process.env.REACT_APP_WS_URL ||
  API_BASE.replace(/^http(s?):\/\//, (match, secure) => `ws${secure}://`).replace(/\/api\/?$/, '');

/**
 * There is no login in this app. The server keeps one local participant and
 * hands it out here, so comments work out of the box.
 */
export const getParticipant = async () => {
  const { data } = await axios.get(`${API_BASE}/participant`);
  return data;
};

export const renameParticipant = async (name) => {
  const { data } = await axios.put(`${API_BASE}/participant`, { name });
  return data;
};

export default API_BASE;
