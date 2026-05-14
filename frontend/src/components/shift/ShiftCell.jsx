import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { format } from 'date-fns';
import { Calendar } from 'lucide-react';

export default function ShiftCell({ date, staff }) {
  const { shifts, requests, openShiftModal, isAdmin } = useAppStore();
  const dateStr = format(date, 'yyyy-MM-dd');

  // 当日のシフトと申請を取得
  const dayShifts = shifts.filter(s => s.staff_id === staff.id && s.date === dateStr);
  const isOff = requests.some(r => r.staff_id === staff.id && (Array.isArray(r.dates) ? r.dates.includes(dateStr) : r.dates === dateStr) && (r.type === 'off' || r.type === 'holiday') && r.status === 'approved');
  const isWorkRequested = requests.some(r => r.staff_id === staff.id && (Array.isArray(r.dates) ? r.dates.includes(dateStr) : r.dates === dateStr) && r.type === 'work' && r.status === 'approved');
  
  // 出勤不可日（配列または文字列）
  const uDates = Array.isArray(staff.unavailable_dates) ? staff.unavailable_dates : (staff.unavailable_dates ? staff.unavailable_dates.split(',').map(d=>d.trim()) : []);
  const isUnavailable = uDates.includes(dateStr) || isOff;

  const handleClick = (e) => {
    if (!isAdmin) return;
    openShiftModal(null, date, staff.id);
  };

  const handleShiftClick = (e, shift) => {
    if (!isAdmin) return;
    e.stopPropagation();
    openShiftModal(shift, date, staff.id);
  };

  return (
    <td 
      className={`border-r border-b border-gray-200 p-1 min-w-[100px] h-16 align-top transition-colors relative group
        ${isUnavailable ? 'bg-red-50/50' : 'hover:bg-blue-50/30'}
        ${isAdmin ? 'cursor-pointer' : ''}
      `}
      onClick={handleClick}
    >
      {/* 申請インジケータ */}
      {isWorkRequested && <div className="absolute top-1 left-1 w-2 h-2 rounded-full bg-blue-500" title="勤務希望あり"></div>}
      {isUnavailable && <div className="absolute inset-0 bg-stripe-red opacity-10 pointer-events-none"></div>}

      <div className="flex flex-col gap-1 w-full h-full">
        {dayShifts.map(shift => (
          <div 
            key={shift.id}
            onClick={(e) => handleShiftClick(e, shift)}
            className="bg-blue-600 text-white text-[11px] font-bold px-2 py-1 rounded shadow-sm flex items-center justify-center hover:bg-blue-700 transition-colors z-10"
          >
            {shift.start_time} - {shift.end_time}
          </div>
        ))}
      </div>
      
      {/* ホバー時の追加ボタン */}
      {isAdmin && dayShifts.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center shadow-sm">
            <i className="fa-solid fa-plus text-xs"></i>
          </div>
        </div>
      )}
    </td>
  );
}
