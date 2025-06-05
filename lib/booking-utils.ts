import { collection, query, where, getDocs, doc, updateDoc, serverTimestamp, increment } from 'firebase/firestore'
import { db } from '@/lib/firebase'

/**
 * Verifică dacă o rezervare este expirată în funcție de data/ora curentă
 */
export function isBookingExpired(booking: {
  endDate: string
  endTime: string
  status: string
}): boolean {
  // Doar rezervările active pot expira
  const activeStatuses = ['confirmed_paid', 'confirmed_test', 'confirmed', 'paid']
  if (!activeStatuses.includes(booking.status)) {
    return false
  }
  
  const now = new Date()
  const endDateTime = new Date(`${booking.endDate}T${booking.endTime}:00`)
  
  return endDateTime <= now
}

/**
 * Obține rezervările active (exclusiv cele expirate) fără să le modifice statusul
 */
export async function getActiveBookings(): Promise<any[]> {
  try {
    const now = new Date()
    const currentDateStr = now.toISOString().split('T')[0] // YYYY-MM-DD
    
    // Query pentru rezervările potențial active
    const bookingsRef = collection(db, 'bookings')
    const activeQuery = query(
      bookingsRef,
      where('status', 'in', ['confirmed_paid', 'confirmed_test', 'confirmed', 'paid']),
      where('endDate', '>=', currentDateStr) // Doar rezervările care se termină astăzi sau în viitor
    )
    
    const snapshot = await getDocs(activeQuery)
    const activeBookings = []
    
    snapshot.forEach((docSnapshot) => {
      const booking = { id: docSnapshot.id, ...docSnapshot.data() }
      
      // Verifică și ora, nu doar data
      if (!isBookingExpired(booking)) {
        activeBookings.push(booking)
      }
    })
    
    return activeBookings
    
  } catch (error) {
    console.error('❌ Error getting active bookings:', error)
    return []
  }
}

/**
 * Obține numărul real de rezervări active (exclusiv cele expirate)
 */
export async function getRealActiveBookingsCount(): Promise<number> {
  const activeBookings = await getActiveBookings()
  return activeBookings.length
}

/**
 * Query inteligent pentru rezervările care ocupă locuri în parcare acum
 */
export async function getCurrentParkingOccupancy(): Promise<{
  activeNow: number
  scheduledToday: number
  totalSpots: number
  occupancyRate: number
}> {
  try {
    const now = new Date()
    const currentDateStr = now.toISOString().split('T')[0]
    const currentTimeStr = now.toTimeString().slice(0, 5) // HH:mm
    
    console.log('🔍 Checking occupancy for:', { currentDateStr, currentTimeStr })
    
    const bookingsRef = collection(db, 'bookings')
    
    // Query pentru rezervările care ar putea fi active astăzi
    const todayBookingsQuery = query(
      bookingsRef,
      where('startDate', '<=', currentDateStr),
      where('endDate', '>=', currentDateStr),
      where('status', 'in', ['confirmed_paid', 'confirmed_test', 'confirmed', 'paid'])
    )
    
    const snapshot = await getDocs(todayBookingsQuery)
    
    let activeNow = 0
    let scheduledToday = 0
    const nowTimestamp = now.getTime()
    
    snapshot.forEach((docSnapshot) => {
      const booking = docSnapshot.data()
      
      const startDateTime = new Date(`${booking.startDate}T${booking.startTime}:00`)
      const endDateTime = new Date(`${booking.endDate}T${booking.endTime}:00`)
      
      const startTimestamp = startDateTime.getTime()
      const endTimestamp = endDateTime.getTime()
      
      // Verifică dacă rezervarea este activă ACUM (între start și end)
      if (startTimestamp <= nowTimestamp && nowTimestamp <= endTimestamp) {
        activeNow++
        console.log('🅰️ Active now:', {
          id: docSnapshot.id,
          licensePlate: booking.licensePlate,
          start: startDateTime.toISOString(),
          end: endDateTime.toISOString()
        })
      }
      // Rezervările programate pentru astăzi (care încă nu au început)
      else if (startTimestamp > nowTimestamp && booking.startDate === currentDateStr) {
        scheduledToday++
        console.log('📅 Scheduled today:', {
          id: docSnapshot.id,
          licensePlate: booking.licensePlate,
          start: startDateTime.toISOString()
        })
      }
    })
    
    const totalSpots = 100 // Configurabil
    const occupancyRate = (activeNow / totalSpots) * 100
    
    console.log('📊 Current occupancy:', {
      activeNow,
      scheduledToday,
      totalSpots,
      occupancyRate: `${occupancyRate.toFixed(1)}%`
    })
    
    return {
      activeNow,
      scheduledToday,
      totalSpots,
      occupancyRate
    }
    
  } catch (error) {
    console.error('❌ Error calculating occupancy:', error)
    return {
      activeNow: 0,
      scheduledToday: 0,
      totalSpots: 100,
      occupancyRate: 0
    }
  }
}

/**
 * Verifică disponibilitatea pentru o nouă rezervare în intervalul specificat
 */
export async function checkAvailability(
  startDate: string,
  startTime: string,
  endDate: string,
  endTime: string
): Promise<{
  available: boolean
  conflictingBookings: number
  totalSpots: number
}> {
  try {
    const newStartDateTime = new Date(`${startDate}T${startTime}:00`)
    const newEndDateTime = new Date(`${endDate}T${endTime}:00`)
    
    console.log('🔍 Checking availability for:', {
      start: newStartDateTime.toISOString(),
      end: newEndDateTime.toISOString()
    })
    
    const bookingsRef = collection(db, 'bookings')
    
    // Query pentru rezervările care se suprapun cu intervalul cerut
    const overlappingQuery = query(
      bookingsRef,
      where('status', 'in', ['confirmed_paid', 'confirmed_test', 'confirmed', 'paid']),
      where('startDate', '<=', endDate),
      where('endDate', '>=', startDate)
    )
    
    const snapshot = await getDocs(overlappingQuery)
    let conflictingBookings = 0
    
    snapshot.forEach((docSnapshot) => {
      const booking = docSnapshot.data()
      
      const existingStartDateTime = new Date(`${booking.startDate}T${booking.startTime}:00`)
      const existingEndDateTime = new Date(`${booking.endDate}T${booking.endTime}:00`)
      
      // Verifică dacă rezervarea nu este expirată
      if (!isBookingExpired(booking)) {
        // Verifică suprapunerea exactă de timp
        if (
          newStartDateTime < existingEndDateTime &&
          newEndDateTime > existingStartDateTime
        ) {
          conflictingBookings++
          console.log('⚠️ Conflicting booking:', {
            id: docSnapshot.id,
            licensePlate: booking.licensePlate,
            start: existingStartDateTime.toISOString(),
            end: existingEndDateTime.toISOString()
          })
        }
      }
    })
    
    const totalSpots = 100 // Configurabil
    const available = conflictingBookings < totalSpots
    
    console.log('📊 Availability check result:', {
      available,
      conflictingBookings,
      totalSpots,
      occupancyRate: `${(conflictingBookings / totalSpots * 100).toFixed(1)}%`
    })
    
    return {
      available,
      conflictingBookings,
      totalSpots
    }
    
  } catch (error) {
    console.error('❌ Error checking availability:', error)
    return {
      available: false,
      conflictingBookings: 0,
      totalSpots: 100
    }
  }
}

/**
 * Funcție de cleanup soft - marchează rezervările expirate doar când sunt accesate
 */
export async function softCleanupExpiredBookings(): Promise<number> {
  try {
    const now = new Date()
    const currentDateStr = now.toISOString().split('T')[0]
    
    const bookingsRef = collection(db, 'bookings')
    const potentiallyExpiredQuery = query(
      bookingsRef,
      where('status', 'in', ['confirmed_paid', 'confirmed_test', 'confirmed', 'paid']),
      where('endDate', '<=', currentDateStr)
    )
    
    const snapshot = await getDocs(potentiallyExpiredQuery)
    let expiredCount = 0
    
    for (const docSnapshot of snapshot.docs) {
      const booking = docSnapshot.data()
      
      if (isBookingExpired(booking)) {
        // Marchează ca expirată
        await updateDoc(docSnapshot.ref, {
          status: 'expired',
          expiredAt: serverTimestamp(),
          lastUpdated: serverTimestamp()
        })
        
        expiredCount++
        console.log('🔄 Soft cleanup expired booking:', {
          id: docSnapshot.id,
          licensePlate: booking.licensePlate
        })
      }
    }
    
    if (expiredCount > 0) {
      // Actualizează statisticile
      const statsDocRef = doc(db, "config", "reservationStats")
      await updateDoc(statsDocRef, {
        activeBookingsCount: increment(-expiredCount),
        lastUpdated: serverTimestamp()
      })
    }
    
    return expiredCount
    
  } catch (error) {
    console.error('❌ Error in soft cleanup:', error)
    return 0
  }
} 