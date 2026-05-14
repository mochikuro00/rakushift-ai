import React from 'react';
import { LogOut, Settings, Users, Calendar } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import API from '../../lib/api';

export default function Header() {
  const { isShopLoggedIn, isAdmin, isHQ, setAuth } = useAppStore();

  const handleLogout = async () => {
    if (confirm('ログアウトしますか？')) {
      await API.logout();
      setAuth({ isShopLoggedIn: false, isAdmin: false, isHQ: false });
    }
  };

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
      {isHQ && (
        <div className="bg-blue-600 text-white text-xs font-bold py-1 px-4 text-center tracking-widest shadow-sm">
          【閲覧専用モード】本部権限でアクセス中（編集操作は無効化されています）
        </div>
      )}
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 text-white rounded flex items-center justify-center font-bold text-xl">R</div>
          <span className="font-bold text-xl tracking-tight text-gray-800">ラクシフトAI</span>
        </div>
        
        {isShopLoggedIn && (
          <div className="flex items-center gap-4">
            <button className="p-2 text-gray-500 hover:text-blue-600 transition-colors">
              <Calendar className="w-5 h-5" />
            </button>
            <button className="p-2 text-gray-500 hover:text-blue-600 transition-colors">
              <Users className="w-5 h-5" />
            </button>
            {isAdmin && (
              <button className="p-2 text-gray-500 hover:text-blue-600 transition-colors">
                <Settings className="w-5 h-5" />
              </button>
            )}
            <div className="h-6 w-px bg-gray-300 mx-2"></div>
            <button 
              onClick={handleLogout}
              className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-red-600 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>ログアウト</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
