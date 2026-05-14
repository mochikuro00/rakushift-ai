import { create } from 'zustand';
import API from '../lib/api';

export const useAppStore = create((set, get) => ({
  // Auth & Permissions
  isShopLoggedIn: false,
  isAdmin: false,
  isHQ: false,
  organizationId: null,
  contractId: null,
  userName: '',
  userRole: '',

  // Data
  config: null,
  staff: [],
  shifts: [],
  requests: [],

  // UI State
  currentView: 'dashboard',
  isLoading: false,
  toast: null,

  // Actions
  setAuth: (authData) => set((state) => ({ ...state, ...authData })),
  logout: () => {
    set({ 
      isShopLoggedIn: false, isAdmin: false, isHQ: false, 
      organizationId: null, contractId: null, userName: '', userRole: '',
      config: null, staff: [], shifts: [], requests: [], currentView: 'dashboard' 
    });
  },
  setData: (data) => set((state) => ({ ...state, ...data })),
  setView: (view) => set({ currentView: view }),
  setLoading: (loading) => set({ isLoading: loading }),
  showToast: (message, type = 'success') => {
    set({ toast: { message, type } });
    setTimeout(() => set({ toast: null }), 3000);
  },

  loadData: async () => {
    const { organizationId, isHQ } = get();
    if (!organizationId) return;

    set({ isLoading: true });
    try {
      const orgFilter = { organization_id: `eq.${organizationId}` };
      const staffSelect = 'id,organization_id,contract_id,name,login_id,role,evaluation,salary_type,hourly_wage,monthly_salary,annual_holidays,max_days_week,max_hours_day,min_days_week,min_days_month,unavailable_dates';
      
      const [configRes, staffRes, shiftsRes, requestsRes] = await Promise.all([
        API.list('config_safe', orgFilter),
        API.list('staff', { ...orgFilter, select: staffSelect }),
        API.list('shifts', orgFilter),
        API.list('requests', orgFilter)
      ]);

      const config = (configRes.data && configRes.data.length > 0) ? configRes.data[0] : null;
      const staff = staffRes.data || [];
      const shifts = shiftsRes.data || [];
      const requests = requestsRes.data || [];

      set({ config, staff, shifts, requests });
      console.log("[Store] Data loaded:", { config, staff, shifts, requests });
    } catch (e) {
      console.error("[Store] Load data failed:", e);
      get().showToast('データの読み込みに失敗しました', 'error');
    } finally {
      set({ isLoading: false });
    }
  }
}));
