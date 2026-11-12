//! An unnamed kill-on-close job contains only this app's owned backend tree.
//! Node starts suspended, so it cannot create children before job assignment.

use std::os::windows::io::AsRawHandle;
use std::process::Child;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

pub struct Job(HANDLE);

impl Job {
    pub fn create() -> Result<Self, String> {
        // SAFETY: no name and no inheritable handle; this job belongs only to us.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err("Windows could not create a backend process job".into());
        }
        let job = Self(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if ok == 0 {
            return Err("Windows could not enable backend cleanup on application exit".into());
        }
        Ok(job)
    }

    pub fn assign_and_resume(&self, child: &Child) -> Result<(), String> {
        let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle().cast()) };
        if ok == 0 {
            return Err("Windows could not contain the backend process; it was stopped to prevent orphaned processes".into());
        }
        // std::process keeps the process handle, but closes CreateProcess's
        // primary-thread handle. Locate only this still-suspended child's thread.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Windows could not resume the contained backend process".into());
        }
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = false;
        let mut more = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while more {
            if entry.th32OwnerProcessID == child.id() {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if !thread.is_null() {
                    let resumed = unsafe { ResumeThread(thread) };
                    unsafe {
                        CloseHandle(thread);
                    }
                    found = resumed != u32::MAX;
                    break;
                }
            }
            more = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }
        unsafe {
            CloseHandle(snapshot);
        }
        if found {
            Ok(())
        } else {
            Err("Windows could not resume the contained backend process".into())
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
