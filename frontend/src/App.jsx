import React, { useEffect } from 'react';
import Header from './components/layout/Header';
import { useAppStore } from './store/useAppStore';
import API from './lib/api';

function App() {
  const { isShopLoggedIn, setAuth } = useAppStore();

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
            organizationId: user.organization_id
          });
        } catch (e) {
          console.error(e);
        }
      }
    };
    initAuth();
  }, [setAuth]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <Header />
      
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {!isShopLoggedIn ? (
          <div className="flex items-center justify-center h-full min-h-[60vh]">
            <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full border border-gray-100">
              <h2 className="text-2xl font-bold text-center mb-6">ログイン（React移行版）</h2>
              <p className="text-gray-600 text-center text-sm mb-6">
                現在React/Viteへの移行作業中です。この画面はモックアップです。
              </p>
              <button 
                className="w-full bg-blue-600 text-white font-bold py-3 px-4 rounded-xl hover:bg-blue-700 transition-colors shadow-md shadow-blue-500/30"
                onClick={() => setAuth({ isShopLoggedIn: true, isAdmin: true })}
              >
                デモログイン
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <h1 className="text-2xl font-bold text-gray-800">ダッシュボード</h1>
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
              <p className="text-gray-600 mb-4">React移行版の基盤構築が完了しました。今後、既存の機能をコンポーネント単位でここに移管していきます。</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
                  <h3 className="font-bold text-blue-800 mb-2">シフト管理</h3>
                  <p className="text-sm text-blue-600">順次実装予定</p>
                </div>
                <div className="bg-green-50 p-4 rounded-lg border border-green-100">
                  <h3 className="font-bold text-green-800 mb-2">スタッフ管理</h3>
                  <p className="text-sm text-green-600">順次実装予定</p>
                </div>
                <div className="bg-purple-50 p-4 rounded-lg border border-purple-100">
                  <h3 className="font-bold text-purple-800 mb-2">本部設定</h3>
                  <p className="text-sm text-purple-600">順次実装予定</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
