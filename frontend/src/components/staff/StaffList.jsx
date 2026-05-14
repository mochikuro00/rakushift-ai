import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Plus, Edit2, Trash2 } from 'lucide-react';

export default function StaffList() {
  const { staff, isAdmin } = useAppStore();
  const [searchTerm, setSearchTerm] = useState('');

  const filteredStaff = staff.filter(s => s.name.includes(searchTerm) || (s.login_id && s.login_id.includes(searchTerm)));

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden animate-fade-in">
      <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
        <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
          <i className="fa-solid fa-users text-blue-600"></i>
          スタッフ管理 ({staff.length}名)
        </h2>
        <div className="flex gap-3">
          <input 
            type="text" 
            placeholder="名前で検索..." 
            className="border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
          {isAdmin && (
            <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-bold shadow-sm flex items-center gap-2 transition-colors">
              <Plus className="w-4 h-4" />
              新規追加
            </button>
          )}
        </div>
      </div>
      
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600 border-b border-gray-200">
            <tr>
              <th className="p-4 font-bold">名前</th>
              <th className="p-4 font-bold">ログインID</th>
              <th className="p-4 font-bold">評価</th>
              <th className="p-4 font-bold">給与形態</th>
              <th className="p-4 font-bold">出勤日数(月)</th>
              {isAdmin && <th className="p-4 font-bold text-center w-24">操作</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredStaff.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 6 : 5} className="p-8 text-center text-gray-500">
                  スタッフが見つかりません。
                </td>
              </tr>
            ) : (
              filteredStaff.map(s => (
                <tr key={s.id} className="hover:bg-blue-50/50 transition-colors">
                  <td className="p-4 font-medium text-gray-800">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold">
                        {s.name.charAt(0)}
                      </div>
                      {s.name}
                      {s.role === 'manager' && <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-bold ml-2">管理者</span>}
                    </div>
                  </td>
                  <td className="p-4 text-gray-600 font-mono text-xs">{s.login_id || '-'}</td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded text-xs font-bold ${s.evaluation === 'A' ? 'bg-green-100 text-green-700' : s.evaluation === 'B' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                      {s.evaluation || 'B'}
                    </span>
                  </td>
                  <td className="p-4 text-gray-600">{s.salary_type === 'monthly' ? '月給' : '時給'}</td>
                  <td className="p-4 text-gray-600">{s.min_days_month || 0}日</td>
                  {isAdmin && (
                    <td className="p-4 text-center">
                      <div className="flex justify-center gap-2">
                        <button className="text-blue-500 hover:bg-blue-50 p-1.5 rounded transition-colors"><Edit2 className="w-4 h-4" /></button>
                        <button className="text-red-500 hover:bg-red-50 p-1.5 rounded transition-colors"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
