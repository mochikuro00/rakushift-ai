import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import API from '../../lib/api';
import { Building2, AlertTriangle, PlayCircle } from 'lucide-react';

export default function HQDashboard() {
  const { setAuth, showToast } = useAppStore();
  const [organizations, setOrganizations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchOrgs = async () => {
      try {
        const res = await API.rpc('hq_get_all_shops');
        if (Array.isArray(res)) {
          setOrganizations(res);
        } else {
          showToast('店舗データの取得に失敗しました', 'error');
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchOrgs();
  }, [showToast]);

  const handleLoginAsShop = async (contractId) => {
    try {
      const res = await API.rpc('hq_login_as_shop', { p_contract: contractId });
      if (res && res.success) {
        const authData = {
          isShopLoggedIn: true,
          isAdmin: true,
          isHQ: true,
          organizationId: res.organization_id,
          contractId: contractId,
          userName: '本部管理者（閲覧モード）'
        };
        localStorage.setItem('rakushift_user', JSON.stringify({ ...authData, role: 'hq_admin' }));
        setAuth(authData);
        showToast(`${res.name} のダッシュボードに移動しました`);
        window.location.reload(); // Hard reload to trigger loadData in App.jsx and reset state cleanly
      }
    } catch (e) {
      console.error(e);
      showToast('店舗へのアクセスに失敗しました', 'error');
    }
  };

  if (loading) return <div className="p-12 text-center">読み込み中...</div>;

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
        <Building2 className="w-6 h-6 text-blue-600" />
        本部ダッシュボード
      </h1>
      
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-6 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
          <h2 className="font-bold text-gray-800">管轄店舗一覧 ({organizations.length}店舗)</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-600 border-b border-gray-200">
              <tr>
                <th className="p-4 font-bold">店舗名</th>
                <th className="p-4 font-bold">契約ID</th>
                <th className="p-4 font-bold">スタッフ数</th>
                <th className="p-4 font-bold">未承認申請</th>
                <th className="p-4 font-bold text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {organizations.map(org => (
                <tr key={org.id} className="hover:bg-blue-50/50 transition-colors">
                  <td className="p-4 font-bold text-gray-800">{org.name}</td>
                  <td className="p-4 text-gray-600 font-mono text-xs">{org.contract_id}</td>
                  <td className="p-4 text-gray-600">{org.staff_count || 0}名</td>
                  <td className="p-4">
                    {org.pending_requests > 0 ? (
                      <span className="flex items-center gap-1 text-orange-600 font-bold bg-orange-100 px-2 py-1 rounded w-max">
                        <AlertTriangle className="w-4 h-4" /> {org.pending_requests}件
                      </span>
                    ) : (
                      <span className="text-gray-400">0件</span>
                    )}
                  </td>
                  <td className="p-4 text-center">
                    <button 
                      onClick={() => handleLoginAsShop(org.contract_id)}
                      className="bg-gray-800 hover:bg-gray-900 text-white px-4 py-2 rounded-lg text-xs font-bold transition-colors shadow-sm flex items-center gap-1 mx-auto"
                    >
                      <PlayCircle className="w-4 h-4" /> 管理画面へ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
