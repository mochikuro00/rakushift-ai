import { create } from 'zustand';

export const useAppStore = create((set) => ({
  // Auth & Permissions
  isShopLoggedIn: false,
  isAdmin: false,
  isHQ: false,
  organizationId: null,

  // Data
  config: null,
  staff: [],
  shifts: [],
  requests: [],

  // UI State
  currentView: 'dashboard',
  isLoading: false,

  // Actions
  setAuth: (authData) => set((state) => ({ ...state, ...authData })),
  logout: () => set({ isShopLoggedIn: false, isAdmin: false, isHQ: false, organizationId: null, config: null, staff: [], shifts: [], requests: [] }),
  setData: (data) => set((state) => ({ ...state, ...data })),
  setView: (view) => set({ currentView: view }),
  setLoading: (loading) => set({ isLoading: loading }),
}));
