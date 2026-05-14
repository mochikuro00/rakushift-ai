import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Check, X, Calendar as CalendarIcon } from 'lucide-react';
import API from '../../lib/api';

export default function RequestList() {
  const { requests, staff, isAdmin, loadData, setLoading } = useAppStore();
  const [filter, setFilter] = useState('pending'); // 'pending', 'all'

  const handleAction = async (id, status) => {
    if (!confirm(status === 'approved' ? '承認しますか？' : '却下しますか？')) return;
    setLoading(true);
    try {
      await API.update('requests', id, { status });
      // TODO: Here we would trigger the shift/staff update logic ported from app_v2.js
      // Since it's complex, for now we just approve it in DB and reload
      await loadData();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const getStaffName = (id) => staff.find(s => s.id === id)?.name || '不明';

  const filtered = requests
    .filter(r => filter === 'all' || r.status === filter)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden animate-fade-in">
      <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
        <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
          <i className="fa-solid fa-envelope-open-text text-orange-600"></i>
          休暇・勤務申請 ({requests.filter(r => r.status === 'pending').length}件未承認)
        </h2>
        <div className="flex gap-2">
          <button 
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${filter === 'pending' ? 'bg-orange-100 text-orange-700' : 'text-gray-500 hover:bg-gray-100'}`}
            onClick={() => setFilter('pending')}
          >未承認のみ</button>
          <button 
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${filter === 'all' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:bg-gray-100'}`}
            onClick={() => setFilter('all')}
          >すべて表示</button>
        </div>
      </div>
      
      <div className="divide-y divide-gray-100">
        {filtered.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            申請はありません。
          </div>
        ) : (
          filtered.map(req => (
            <div key={req.id} className="p-6 hover:bg-orange-50/30 transition-colors flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex items-start gap-4 flex-1">
                <div className={`p-3 rounded-full ${req.type === 'work' ? 'bg-blue-100 text-blue-600' : 'bg-red-100 text-red-600'}`}>
                  {req.type === 'work' ? <CalendarIcon className="w-6 h-6" /> : <CalendarIcon className="w-6 h-6" />}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-bold text-gray-800">{getStaffName(req.staff_id)}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${req.type === 'work' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'}`}>
                      {req.type === 'work' ? '勤務希望' : '休み希望'}
                    </span>
                    {req.status === 'approved' && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-bold">承認済</span>}
                    {req.status === 'rejected' && <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-bold">却下</span>}
                  </div>
                  <div className="font-bold text-gray-700 mb-2">
                    {Array.isArray(req.dates) ? req.dates.join(', ') : req.dates}
                  </div>
                  {req.reason && (
                    <div className="bg-gray-50 text-gray-600 text-sm p-3 rounded-lg border border-gray-100">
                      "{req.reason}"
                    </div>
                  )}
                  <div className="text-xs text-gray-400 mt-2">
                    申請日時: {new Date(req.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
              
              {isAdmin && req.status === 'pending' && (
                <div className="flex gap-2">
                  <button 
                    onClick={() => handleAction(req.id, 'approved')}
                    className="flex items-center gap-1 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-bold transition-colors shadow-sm"
                  >
                    <Check className="w-4 h-4" /> 承認
                  </button>
                  <button 
                    onClick={() => handleAction(req.id, 'rejected')}
                    className="flex items-center gap-1 bg-gray-200 hover:bg-gray-300 text-gray-700 px-4 py-2 rounded-lg font-bold transition-colors shadow-sm"
                  >
                    <X className="w-4 h-4" /> 却下
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
