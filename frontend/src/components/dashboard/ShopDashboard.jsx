import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Users, Calendar, Settings, Clock, AlertTriangle } from 'lucide-react';
import StaffList from '../staff/StaffList';
import RequestList from '../request/RequestList';
import ShiftTable from '../shift/ShiftTable';
import ConfigPanel from '../config/ConfigPanel';

export default function ShopDashboard() {
  const { config, staff, shifts, requests, currentView, setView } = useAppStore();

  const renderContent = () => {
    switch (currentView) {
      case 'staff':
        return <StaffList />;
      case 'request':
        return <RequestList />;
      case 'shift':
        return <ShiftTable />;
      case 'config':
        return <ConfigPanel />;
      case 'dashboard':
      default:
        return (
          <div className="space-y-6 animate-fade-in">
            <h1 className="text-2xl font-bold text-gray-800">店舗ダッシュボード</h1>
            
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div 
                className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-all hover:border-blue-300"
                onClick={() => setView('shift')}
              >
                <div className="flex items-center gap-4 mb-2">
                  <div className="bg-blue-100 p-3 rounded-lg text-blue-600"><Calendar className="w-6 h-6" /></div>
                  <h3 className="font-bold text-gray-700">シフト管理</h3>
                </div>
                <p className="text-2xl font-bold text-gray-900">{shifts.length} <span className="text-sm font-normal text-gray-500">件のシフト</span></p>
              </div>
              
              <div 
                className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-all hover:border-green-300"
                onClick={() => setView('staff')}
              >
                <div className="flex items-center gap-4 mb-2">
                  <div className="bg-green-100 p-3 rounded-lg text-green-600"><Users className="w-6 h-6" /></div>
                  <h3 className="font-bold text-gray-700">スタッフ管理</h3>
                </div>
                <p className="text-2xl font-bold text-gray-900">{staff.length} <span className="text-sm font-normal text-gray-500">名</span></p>
              </div>

              <div 
                className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-all hover:border-orange-300"
                onClick={() => setView('request')}
              >
                <div className="flex items-center gap-4 mb-2">
                  <div className="bg-orange-100 p-3 rounded-lg text-orange-600"><AlertTriangle className="w-6 h-6" /></div>
                  <h3 className="font-bold text-gray-700">未承認の申請</h3>
                </div>
                <p className="text-2xl font-bold text-gray-900">{requests.filter(r => r.status === 'pending').length} <span className="text-sm font-normal text-gray-500">件</span></p>
              </div>

              <div 
                className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-all hover:border-purple-300"
                onClick={() => setView('config')}
              >
                <div className="flex items-center gap-4 mb-2">
                  <div className="bg-purple-100 p-3 rounded-lg text-purple-600"><Settings className="w-6 h-6" /></div>
                  <h3 className="font-bold text-gray-700">店舗設定</h3>
                </div>
                <p className="text-sm text-gray-500 mt-2">営業時間: {config?.opening_time || '09:00'} - {config?.closing_time || '18:00'}</p>
              </div>
            </div>

            {/* Notice Board or Quick Actions */}
            <div className="bg-blue-50 border border-blue-100 p-6 rounded-xl">
              <h3 className="text-blue-800 font-bold mb-2 flex items-center gap-2"><Clock className="w-5 h-5"/> 最新のお知らせ</h3>
              <p className="text-blue-600 text-sm">現在、React (Vite) バージョンへの移行作業中です。一部の機能は旧画面での操作をお願いする場合があります。</p>
            </div>
          </div>
        );
    }
  };

  return renderContent();
}
