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
      if (mode === 'shop') res = await API.rpc('verify_shop_login', { p_contract_id: contractId, p_password: password });
      else if (mode === 'admin') res = await API.rpc('verify_admin_login', { p_contract_id: contractId, p_login_id: 'admin', p_password: password });
      else res = await API.rpc('hq_login', { p_login_id: contractId, p_password: password });


      if (res && (res.status === 'success' || res.success === true)) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-100 p-4">
      <div className="bg-white w-full max-w-4xl rounded-2xl shadow-2xl overflow-hidden flex flex-col md:flex-row h-auto md:h-[600px] max-h-[90vh] overflow-y-auto">
        
        {/* Left: Branding */}
        <div className="md:w-1/2 bg-blue-600 text-white p-8 flex flex-col justify-center items-center text-center">
          <img src="/images/rakushift_logo_transparent.png" alt="ラクシフトAI" className="w-48 mb-6 brightness-0 invert opacity-90" />
          <h2 className="text-3xl font-bold mb-2">Rakushift AI</h2>
          <p className="text-blue-100 mb-8">AIが最適なシフトを自動生成。<br />店舗運営を劇的に効率化します。</p>
          <div className="space-y-4 text-left text-sm text-blue-100 bg-blue-700/30 p-6 rounded-xl w-full max-w-xs mx-auto">
            <div className="flex items-center gap-3"><i className="fa-solid fa-check-circle"></i> <span>1クリックで自動作成</span></div>
            <div className="flex items-center gap-3"><i className="fa-solid fa-check-circle"></i> <span>クラウド保存・共有</span></div>
          </div>
        </div>

        {/* Right: Login Forms */}
        <div className="md:w-1/2 p-8 bg-gray-50 flex flex-col justify-center relative">
          
          {/* 3 Tabs */}
          <div className="flex bg-gray-200/60 p-1 rounded-lg mb-8 shadow-inner">
            <button 
              type="button"
              className={`flex-1 py-2 text-xs md:text-sm font-bold rounded-md transition-all ${mode === 'shop' ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:bg-white/50'}`}
              onClick={() => { setMode('shop'); setContractId(''); setPassword(''); }}
            >一般</button>
            <button 
              type="button"
              className={`flex-1 py-2 text-xs md:text-sm font-bold rounded-md transition-all ${mode === 'admin' ? 'bg-white shadow text-purple-600' : 'text-gray-500 hover:bg-white/50'}`}
              onClick={() => { setMode('admin'); setContractId(''); setPassword(''); }}
            >管理者</button>
            <button 
              type="button"
              className={`flex-1 py-2 text-xs md:text-sm font-bold rounded-md transition-all ${mode === 'hq' ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:bg-white/50'}`}
              onClick={() => { setMode('hq'); setContractId(''); setPassword(''); }}
            >本部・統括</button>
          </div>

          <h3 className="text-2xl font-bold text-gray-800 text-center mb-2">
            {mode === 'shop' ? '店舗ログイン' : mode === 'admin' ? '管理者ログイン' : '本部ログイン'}
          </h3>
          <p className="text-xs text-gray-500 text-center mb-6">
            {mode === 'shop' ? '契約IDとパスワードを入力してください' : mode === 'admin' ? '契約IDと管理者パスワードを入力してください' : '本部用IDとパスワードを入力してください'}
          </p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">
                {mode === 'hq' ? '本部ID' : '契約ID (Contract ID)'}
              </label>
              <input 
                type="text" 
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                value={contractId}
                onChange={e => setContractId(e.target.value)}
                placeholder={mode === 'hq' ? '例: demo (または 本部ID)' : '例: demo (または 15桁の契約ID)'}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">パスワード</label>
              <input 
                type="password" 
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="パスワード"
              />
            </div>

            <button 
              type="submit"
              className={`w-full py-3 text-white font-bold rounded-xl shadow-lg transition mt-4 ${mode === 'hq' ? 'bg-indigo-600 hover:bg-indigo-700' : mode === 'admin' ? 'bg-purple-600 hover:bg-purple-700' : 'bg-blue-600 hover:bg-blue-700'}`}
            >
              ログイン
            </button>
            
            {mode === 'shop' && (
              <div className="text-center mt-6 pt-6 border-t border-gray-200">
                <p className="text-sm text-gray-600 mb-3">まだアカウントをお持ちでない方</p>
                <button type="button" onClick={() => alert('新規登録は現在メンテナンス中です。')} className="w-full py-3 bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-bold rounded-xl shadow-lg transition">
                    <i className="fa-solid fa-rocket mr-2"></i>新規お申し込み
                </button>
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
