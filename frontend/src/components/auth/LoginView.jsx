import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import API from '../../lib/api';

export default function LoginView() {
  const { setAuth, setLoading, showToast, loadData } = useAppStore();
  const [contractId, setContractId] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState('shop'); // 'shop', 'admin', 'hq'

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!contractId || !password) return;

    setLoading(true);
    try {
      let res;
      if (mode === 'shop') res = await API.rpc('verify_shop_login', { p_contract: contractId, p_pass: password });
      else if (mode === 'admin') res = await API.rpc('verify_admin_login', { p_contract: contractId, p_pass: password });
      else res = await API.rpc('hq_login', { p_pass: password });

      if (res && res.success) {
        const authData = {
          isShopLoggedIn: true,
          isAdmin: mode === 'admin' || mode === 'hq',
          isHQ: mode === 'hq',
          organizationId: res.organization_id || null,
          contractId: contractId,
          userName: mode === 'hq' ? '本部管理者' : res.name || '管理者'
        };
        
        localStorage.setItem('rakushift_user', JSON.stringify({
          ...authData,
          role: mode === 'hq' ? 'hq_admin' : (mode === 'admin' ? 'admin' : 'manager')
        }));

        setAuth(authData);
        showToast('ログインしました');
        
        if (mode !== 'hq') {
          await loadData();
        }
      } else {
        showToast('IDまたはパスワードが違います', 'error');
      }
    } catch (error) {
      console.error(error);
      showToast('エラーが発生しました', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center h-full min-h-[60vh]">
      <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full border border-gray-100">
        <h2 className="text-2xl font-bold text-center mb-6">ログイン</h2>
        
        <div className="flex bg-gray-100 p-1 rounded-lg mb-6">
          <button 
            className={`flex-1 py-2 text-sm font-bold rounded-md transition-all ${mode === 'shop' ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}
            onClick={() => setMode('shop')}
          >店舗用</button>
          <button 
            className={`flex-1 py-2 text-sm font-bold rounded-md transition-all ${mode === 'admin' ? 'bg-white shadow text-purple-600' : 'text-gray-500'}`}
            onClick={() => setMode('admin')}
          >店舗管理者</button>
          <button 
            className={`flex-1 py-2 text-sm font-bold rounded-md transition-all ${mode === 'hq' ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}
            onClick={() => setMode('hq')}
          >統括本部</button>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          {mode !== 'hq' && (
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-1">契約ID</label>
              <input 
                type="text" 
                className="w-full border-gray-300 rounded-lg p-3 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 transition-all outline-none"
                value={contractId}
                onChange={e => setContractId(e.target.value)}
                placeholder="例: shop001"
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">パスワード</label>
            <input 
              type="password" 
              className="w-full border-gray-300 rounded-lg p-3 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 transition-all outline-none"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          <button 
            type="submit"
            className={`w-full text-white font-bold py-3 px-4 rounded-xl transition-colors shadow-md mt-6 ${mode === 'hq' ? 'bg-gray-800 hover:bg-gray-900' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/30'}`}
          >
            ログイン
          </button>
        </form>
      </div>
    </div>
  );
}
