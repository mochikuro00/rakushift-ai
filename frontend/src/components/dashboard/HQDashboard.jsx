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

  const handleLoginAsShop = async (orgId, contractId, name) => {
    try {
      const authData = {
        isShopLoggedIn: true,
        isAdmin: true,
        isHQ: true,
        organizationId: orgId,
        contractId: contractId,
        userName: '本部管理者（閲覧モード）',
        session_id: JSON.parse(localStorage.getItem('rakushift_user') || '{}').session_id
      };
      localStorage.setItem('rakushift_user', JSON.stringify({ ...authData, role: 'hq_admin' }));
      setAuth(authData);
      showToast(`${name || '店舗'} のダッシュボードに移動しました`);
      window.location.reload(); // Hard reload to trigger loadData in App.jsx and reset state cleanly
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
                <th className="p-4 font-bold">プラン</th>
                <th className="p-4 font-bold">登録日</th>
                <th className="p-4 font-bold text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {organizations.map(org => (
                <tr key={org.organization_id} className="hover:bg-blue-50/50 transition-colors">
                  <td className="p-4 font-bold text-gray-800">{org.name}</td>
                  <td className="p-4 text-gray-600 font-mono text-xs">{org.contract_id}</td>
                  <td className="p-4">
                    <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                      {org.plan || 'Free'}
                    </span>
                  </td>
                  <td className="p-4 text-gray-400 text-sm">
                    {org.created_at ? new Date(org.created_at).toLocaleDateString() : '-'}
                  </td>
                  <td className="p-4 text-center">
                    <button 
                      onClick={() => handleLoginAsShop(org.organization_id, org.contract_id, org.name)}
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
