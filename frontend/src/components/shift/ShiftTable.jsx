import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { format, addDays, startOfWeek } from 'date-fns';
import { ja } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Wand2, Calculator, Download, Calendar } from 'lucide-react';
import ShiftCell from './ShiftCell';
import ShiftModal from './ShiftModal';
import AIControlPanel from './AIControlPanel';

export default function ShiftTable() {
  const { staff, weekStartDate, nextWeek, prevWeek, setWeekStartDate, isAdmin } = useAppStore();
  const [showAIControl, setShowAIControl] = useState(false);

  // Generate week dates
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStartDate, i));

  // Custom CSS for stripe pattern (used in cell for unavailable dates)
  const stripeStyle = `
    .bg-stripe-red {
      background-image: repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(239, 68, 68, 0.2) 10px, rgba(239, 68, 68, 0.2) 20px);
    }
  `;

  return (
    <div className="space-y-4 animate-fade-in">
      <style>{stripeStyle}</style>
      
      {/* ツールバー */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-4">
          <button onClick={prevWeek} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
          
          <div className="flex items-center gap-2 font-bold text-gray-800 text-lg min-w-[200px] justify-center">
            <Calendar className="w-5 h-5 text-blue-600" />
            {format(weekStartDate, 'yyyy年 MM月', { locale: ja })} 
            <span className="text-sm text-gray-500 ml-2">第 {Math.ceil(weekStartDate.getDate() / 7)} 週</span>
          </div>

          <button onClick={nextWeek} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">
            <ChevronRight className="w-5 h-5" />
          </button>
          
          <input 
            type="date" 
            className="border border-gray-300 rounded-lg p-2 text-sm text-gray-700 outline-none focus:ring-2 focus:ring-blue-500"
            value={format(weekStartDate, 'yyyy-MM-dd')}
            onChange={(e) => {
              if(e.target.value) setWeekStartDate(e.target.value);
            }}
          />
        </div>

        {isAdmin && (
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setShowAIControl(!showAIControl)}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold text-sm shadow-sm transition-colors flex items-center gap-2"
            >
              <Wand2 className="w-4 h-4" /> AIシフト自動生成
            </button>
            <button className="bg-gray-800 hover:bg-gray-900 text-white px-4 py-2 rounded-lg font-bold text-sm shadow-sm transition-colors flex items-center gap-2">
              <Download className="w-4 h-4" /> ダウンロード
            </button>
          </div>
        )}
      </div>

      {showAIControl && isAdmin && <AIControlPanel />}

      {/* シフト表 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[800px]">
          <thead className="bg-gray-50 text-gray-700">
            <tr>
              <th className="p-4 border-r border-b border-gray-200 font-bold w-48 sticky left-0 bg-gray-50 z-20 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                スタッフ
              </th>
              {weekDates.map(date => {
                const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                const isSunday = date.getDay() === 0;
                return (
                  <th key={date.toISOString()} className={`p-3 border-r border-b border-gray-200 text-center ${isSunday ? 'text-red-600' : (isWeekend ? 'text-blue-600' : '')}`}>
                    <div className="text-xs font-bold mb-1">{format(date, 'MM/dd')}</div>
                    <div className="text-[10px] uppercase bg-white rounded border border-gray-200 px-2 py-0.5 inline-block">{format(date, 'E', { locale: ja })}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {staff.map(member => (
              <tr key={member.id} className="hover:bg-gray-50/50">
                <td className="p-3 border-r border-b border-gray-200 font-bold text-gray-800 sticky left-0 bg-white z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)] text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs">
                      {member.name.charAt(0)}
                    </div>
                    {member.name}
                  </div>
                </td>
                {weekDates.map(date => (
                  <ShiftCell key={`${member.id}-${date.toISOString()}`} date={date} staff={member} />
                ))}
              </tr>
            ))}
            {staff.length === 0 && (
              <tr>
                <td colSpan={8} className="p-12 text-center text-gray-500">
                  スタッフが登録されていません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ShiftModal />
    </div>
  );
}
