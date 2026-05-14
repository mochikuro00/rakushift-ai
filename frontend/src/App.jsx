import React, { useEffect } from 'react';
import Header from './components/layout/Header';
import LoginView from './components/auth/LoginView';
import { Loading } from './components/ui';
import Toast from './components/ui/Toast';
import ShopDashboard from './components/dashboard/ShopDashboard';
import HQDashboard from './components/dashboard/HQDashboard';
import { useAppStore } from './store/useAppStore';
import API from './lib/api';

function App() {
  const { isShopLoggedIn, isHQ, organizationId, setAuth, loadData } = useAppStore();

  useEffect(() => {
    // 起動時のセッション復元
    const initAuth = async () => {
      await API.init();
      const savedSession = localStorage.getItem('rakushift_user');
      if (savedSession) {
        try {
          const user = JSON.parse(savedSession);
          setAuth({
            isShopLoggedIn: true,
            isAdmin: user.role === 'admin' || user.role === 'manager' || user.role === 'hq_admin',
            isHQ: user.role === 'hq_admin',
            organizationId: user.organization_id,
            contractId: user.contractId,
            userName: user.userName
          });
          if (user.role !== 'hq_admin') {
            await loadData();
          }
        } catch (e) {
          console.error(e);
        }
      }
    };
    initAuth();
  }, [setAuth, loadData]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans text-gray-800">
      <Header />
      <Loading />
      <Toast />
      
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {!isShopLoggedIn ? (
          <LoginView />
        ) : isHQ && !organizationId ? (
          <HQDashboard />
        ) : (
          <ShopDashboard />
        )}
      </main>
    </div>
  );
}

export default App;
