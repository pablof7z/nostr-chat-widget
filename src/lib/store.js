import { writable } from 'svelte/store';

export const chatAdapter = writable(null);
export const chatData = writable({ events: [], profiles: {}});
export const selectedMessage = writable(null);
export const zappingMessage = writable(null);
export const zapsPerMessage = writable({});