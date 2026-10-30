//! Bounded fd readiness for owned pipes and the private service listener.
use std::{io, os::fd::RawFd, time::Duration};

pub(crate) fn wait(fds: &[RawFd], timeout: Option<Duration>) -> io::Result<()> {
    let mut events: Vec<_> = fds
        .iter()
        .map(|&fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    let millis = timeout.map_or(-1, |duration| {
        duration
            .as_millis()
            .saturating_add(u128::from(duration.subsec_nanos() % 1_000_000 != 0))
            .min(i32::MAX as u128) as i32
    });
    // SAFETY: events owns each pollfd for this call; callers retain all fds.
    let ready = unsafe { libc::poll(events.as_mut_ptr(), events.len() as libc::nfds_t, millis) };
    if ready < 0 {
        let error = io::Error::last_os_error();
        // Let the owner recheck cancellation/deadlines before waiting again.
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    if events
        .iter()
        .any(|event| event.revents & (libc::POLLNVAL | libc::POLLERR) != 0)
    {
        return Err(io::Error::other("readiness descriptor failed"));
    }
    Ok(())
}
